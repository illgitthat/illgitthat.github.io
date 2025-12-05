import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.180.0/three.module.min.js';
import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.13.1/rapier.es.js';

await RAPIER.init();

const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');
const scoreEl = document.getElementById('score');
const statusEl = document.getElementById('status');

const TABLE_WIDTH = 12;
const TABLE_HEIGHT = 7;
const PADDLE_HEIGHT = 1.6;
const PADDLE_THICKNESS = 0.5;
const BALL_RADIUS = 0.35;
const GOAL_MARGIN = 0.7;
const GOAL_HEIGHT = 2.4;
const MAX_BALL_SPEED = 11;
const MIN_ACTIVE_SPEED = 1.2;

let scene, camera, renderer;
let world;
let ball = { body: null, mesh: null };
let ballActivated = false;
let paddles = {
    left: { body: null, mesh: null, lastPos: new THREE.Vector3() },
    right: { body: null, mesh: null, lastPos: new THREE.Vector3() }
};
let scores = { left: 0, right: 0 };
let scoreboard = { canvas: null, ctx: null, texture: null, mesh: null };
const backgroundMusic = {
    audio: null,
    targetVolume: 0.25,
    fadeDuration: 900,
    sliderEl: null,
    sliderValueEl: null,
    retryIntervalId: null
};

const handState = {
    left: { detected: false, isPinching: false, world: new THREE.Vector3() },
    right: { detected: false, isPinching: false, world: new THREE.Vector3() }
};

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

const setVolume = value => {
    const v = clamp(value, 0, 1);
    backgroundMusic.targetVolume = v;
    if (backgroundMusic.audio) {
        backgroundMusic.audio.volume = v;
        backgroundMusic.audio.muted = v === 0;
    }
    if (backgroundMusic.sliderEl) backgroundMusic.sliderEl.value = v;
    if (backgroundMusic.sliderValueEl) backgroundMusic.sliderValueEl.textContent = `${Math.round(v * 100)}%`;
};

const ensureMusicLoaded = () => {
    if (backgroundMusic.audio) return;
    const audio = new Audio('assets/neoncollision.mp3');
    audio.loop = true;
    audio.volume = backgroundMusic.targetVolume;
    audio.preload = 'auto';
    backgroundMusic.audio = audio;
};

const fadeVolume = (to, duration = 1200) => {
    if (!backgroundMusic.audio) return;
    const audio = backgroundMusic.audio;
    const from = audio.volume;
    const delta = to - from;
    const startTime = performance.now();

    const step = now => {
        const t = clamp((now - startTime) / duration, 0, 1);
        audio.volume = from + delta * t;
        if (t < 1) requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
};

const startBackgroundMusic = () => {
    ensureMusicLoaded();
    const audio = backgroundMusic.audio;
    if (!audio) return;

    if (!audio.paused) {
        fadeVolume(backgroundMusic.targetVolume, 500);
        return;
    }

    audio.muted = false;
    audio.volume = Math.min(audio.volume, 0.08); // quick onset so it is audible
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(() => fadeVolume(backgroundMusic.targetVolume, backgroundMusic.fadeDuration))
            .catch(err => console.warn('Music playback blocked until user interacts.', err));
    } else {
        fadeVolume(backgroundMusic.targetVolume, backgroundMusic.fadeDuration);
    }
};

const stopBackgroundMusic = () => {
    if (!backgroundMusic.audio) return;
    fadeVolume(0, 800);
    setTimeout(() => backgroundMusic.audio && backgroundMusic.audio.pause(), 820);
};

const primeAutoplayAttempt = () => {
    ensureMusicLoaded();
    const audio = backgroundMusic.audio;
    if (!audio) return;

    audio.muted = true;
    audio.volume = 0;
    const attempt = audio.play();
    if (attempt && typeof attempt.then === 'function') {
        attempt.then(() => {
            audio.pause();
            audio.currentTime = 0;
            audio.muted = false;
            audio.volume = backgroundMusic.targetVolume;
        }).catch(() => {
            audio.muted = false;
            audio.volume = backgroundMusic.targetVolume;
        });
    }
};

const kickAutoplay = () => {
    // Try immediately
    startBackgroundMusic();

    // Keep retrying periodically until it plays
    if (backgroundMusic.retryIntervalId) return;
    backgroundMusic.retryIntervalId = setInterval(() => {
        startBackgroundMusic();
        if (backgroundMusic.audio && !backgroundMusic.audio.paused) {
            clearInterval(backgroundMusic.retryIntervalId);
            backgroundMusic.retryIntervalId = null;
        }
    }, 2500);
};

const setupBackgroundMusic = () => {
    ensureMusicLoaded();
    backgroundMusic.sliderEl = document.getElementById('volume-slider');
    backgroundMusic.sliderValueEl = document.getElementById('volume-value');

    setVolume(backgroundMusic.targetVolume);
    primeAutoplayAttempt();
    kickAutoplay();

    if (backgroundMusic.sliderEl) {
        backgroundMusic.sliderEl.addEventListener('input', e => {
            const v = parseFloat(e.target.value);
            setVolume(v);
            if (backgroundMusic.audio && !backgroundMusic.audio.paused) {
                backgroundMusic.audio.volume = v;
            }
        });
    }

    const unlock = () => {
        kickAutoplay();
    };

    ['pointerdown', 'pointermove', 'touchstart', 'keydown'].forEach(evt => {
        window.addEventListener(evt, unlock, { passive: true });
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopBackgroundMusic();
        } else {
            kickAutoplay();
        }
    });

    kickAutoplay();
};

const normalizedToWorld = (x, y) => {
    const mirroredX = 1 - x;
    const worldX = (mirroredX - 0.5) * TABLE_WIDTH;
    const worldY = (0.5 - y) * TABLE_HEIGHT;
    return new THREE.Vector3(worldX, worldY, 0);
};

const isPinch = landmarks => {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    return d(landmarks[4], landmarks[8]) < 0.065;
};

const setStatus = text => {
    statusEl.textContent = text;
};

const updateScore = () => {
    scoreEl.textContent = `Left ${scores.left} — Right ${scores.right}`;
    if (scoreboard.ctx) {
        renderScoreboardTexture();
    }
};

let particles = [];

const createExplosion = (x, y, color) => {
    const particleCount = 60;
    const geom = new THREE.BoxGeometry(0.15, 0.15, 0.15);
    const mat = new THREE.MeshBasicMaterial({ color: color });

    for (let i = 0; i < particleCount; i++) {
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(x, y, 0.2);

        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 5;
        const vel = {
            x: Math.cos(angle) * speed,
            y: Math.sin(angle) * speed,
            z: (Math.random() - 0.5) * 5
        };

        scene.add(mesh);
        particles.push({ mesh, vel, life: 1.0 });
    }
};

const updateParticles = () => {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= 0.015;

        if (p.life <= 0) {
            scene.remove(p.mesh);
            particles.splice(i, 1);
            continue;
        }

        p.mesh.position.x += p.vel.x * 0.016;
        p.mesh.position.y += p.vel.y * 0.016;
        p.mesh.position.z += p.vel.z * 0.016;
        p.mesh.rotation.x += 0.1;
        p.mesh.rotation.y += 0.1;
        p.mesh.scale.setScalar(p.life);
    }
};

const initThree = () => {
    scene = new THREE.Scene();
    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 100);
    camera.position.set(0, 0, 15);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.inset = '0';
    renderer.domElement.style.pointerEvents = 'none';
    document.getElementById('three-root').appendChild(renderer.domElement);

    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(3, 5, 6);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0x8888aa, 0.6));

    const textureLoader = new THREE.TextureLoader();
    const tableTexture = textureLoader.load('assets/table.png');

    const tableMaterial = new THREE.MeshStandardMaterial({
        map: tableTexture,
        roughness: 0.2,
        metalness: 0.8,
        transparent: true,
        opacity: 0.9
    });
    const tableGeom = new THREE.PlaneGeometry(TABLE_WIDTH + 1.4, TABLE_HEIGHT + 1.2);
    const table = new THREE.Mesh(tableGeom, tableMaterial);
    table.position.z = -0.5;
    scene.add(table);

    const edgeMat = new THREE.LineBasicMaterial({ color: 0x42e8e0, linewidth: 2 });
    const edgeGeom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-TABLE_WIDTH / 2, -TABLE_HEIGHT / 2, 0.05),
        new THREE.Vector3(TABLE_WIDTH / 2, -TABLE_HEIGHT / 2, 0.05),
        new THREE.Vector3(TABLE_WIDTH / 2, TABLE_HEIGHT / 2, 0.05),
        new THREE.Vector3(-TABLE_WIDTH / 2, TABLE_HEIGHT / 2, 0.05),
        new THREE.Vector3(-TABLE_WIDTH / 2, -TABLE_HEIGHT / 2, 0.05)
    ]);
    const edges = new THREE.Line(edgeGeom, edgeMat);
    scene.add(edges);

    // Center Line
    const centerLineGeom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, -TABLE_HEIGHT / 2, 0.05),
        new THREE.Vector3(0, TABLE_HEIGHT / 2, 0.05)
    ]);
    const centerLine = new THREE.Line(centerLineGeom, new THREE.LineBasicMaterial({ color: 0x42e8e0, transparent: true, opacity: 0.5 }));
    scene.add(centerLine);

    // Center Circle
    const circleGeom = new THREE.RingGeometry(1.5, 1.55, 32);
    const circleMat = new THREE.MeshBasicMaterial({ color: 0x42e8e0, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const circle = new THREE.Mesh(circleGeom, circleMat);
    circle.position.z = 0.05;
    scene.add(circle);

    createScoreboard();
    createGoalVisuals();
};

function createGoalVisuals() {
    const goalMaterialLeft = new THREE.LineBasicMaterial({ color: 0x42e8e0, linewidth: 3, transparent: true, opacity: 0.9 });
    const goalMaterialRight = new THREE.LineBasicMaterial({ color: 0xff7ad1, linewidth: 3, transparent: true, opacity: 0.9 });

    const makeGoal = (x, mat, colorHex) => {
        const h = GOAL_HEIGHT / 2;
        const d = 0.8; // depth
        const pts = [
            new THREE.Vector3(x, -h, 0.15),
            new THREE.Vector3(x, h, 0.15),
            new THREE.Vector3(x + (x > 0 ? d : -d), h, 0.15),
            new THREE.Vector3(x + (x > 0 ? d : -d), -h, 0.15),
            new THREE.Vector3(x, -h, 0.15)
        ];
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const line = new THREE.Line(geom, mat);
        scene.add(line);

        // Add a glow plane
        const planeGeom = new THREE.PlaneGeometry(d, GOAL_HEIGHT);
        const planeMat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.2, side: THREE.DoubleSide });
        const plane = new THREE.Mesh(planeGeom, planeMat);
        plane.position.set(x + (x > 0 ? d / 2 : -d / 2), 0, 0.05);
        scene.add(plane);
    };

    makeGoal(-TABLE_WIDTH / 2, goalMaterialLeft, 0x42e8e0);
    makeGoal(TABLE_WIDTH / 2, goalMaterialRight, 0xff7ad1);
}

const createScoreboard = () => {
    scoreboard.canvas = document.createElement('canvas');
    scoreboard.canvas.width = 512;
    scoreboard.canvas.height = 192;
    scoreboard.ctx = scoreboard.canvas.getContext('2d');
    renderScoreboardTexture();

    scoreboard.texture = new THREE.CanvasTexture(scoreboard.canvas);
    const mat = new THREE.MeshBasicMaterial({ map: scoreboard.texture, transparent: true });
    const geom = new THREE.PlaneGeometry(6.5, 2.4);
    scoreboard.mesh = new THREE.Mesh(geom, mat);
    scoreboard.mesh.position.set(0, TABLE_HEIGHT / 2 + 1.4, 0.15);
    scene.add(scoreboard.mesh);
};

const renderScoreboardTexture = () => {
    const c = scoreboard.canvas;
    const g = scoreboard.ctx;
    if (!c || !g) return;

    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(5, 5, 15, 0.7)';
    g.fillRect(0, 0, c.width, c.height);

    g.fillStyle = 'rgba(66, 232, 224, 0.18)';
    g.fillRect(0, 0, c.width / 2, c.height);
    g.fillStyle = 'rgba(255, 122, 209, 0.18)';
    g.fillRect(c.width / 2, 0, c.width / 2, c.height);

    g.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    g.lineWidth = 4;
    g.strokeRect(6, 6, c.width - 12, c.height - 12);
    g.beginPath();
    g.moveTo(c.width / 2, 10);
    g.lineTo(c.width / 2, c.height - 10);
    g.stroke();

    g.fillStyle = '#42e8e0';
    g.font = 'bold 64px Space Grotesk, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(scores.left.toString(), c.width * 0.25, c.height * 0.55);

    g.fillStyle = '#ff7ad1';
    g.fillText(scores.right.toString(), c.width * 0.75, c.height * 0.55);

    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.font = '22px Space Grotesk, sans-serif';
    g.fillText('NEON HAND PONG', c.width / 2, c.height * 0.22);

    if (scoreboard.texture) {
        scoreboard.texture.needsUpdate = true;
    }
};

const initPhysics = () => {
    world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    world.integrationParameters.dt = 1 / 60;

    const wallY = TABLE_HEIGHT / 2 + 0.4;
    const wallWidth = TABLE_WIDTH + 4;
    const wallThickness = 0.5;

    const createWall = y => {
        const rb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, y, 0));
        const col = RAPIER.ColliderDesc.cuboid(wallWidth / 2, wallThickness / 2, 0.2).setRestitution(1);
        world.createCollider(col, rb);
    };

    createWall(wallY);
    createWall(-wallY);

    createEndBumpers();

    paddles.left = createPaddle('left');
    paddles.right = createPaddle('right');
    ball = createBall();
};

const createEndBumpers = () => {
    const segmentHeight = Math.max(0.2, (TABLE_HEIGHT - GOAL_HEIGHT) / 2);
    const halfHeight = segmentHeight / 2;
    const gapOffset = GOAL_HEIGHT / 2 + halfHeight;
    const thickness = 0.35;
    const xOffset = TABLE_WIDTH / 2 + GOAL_MARGIN / 2;

    const makeSegment = (x, y) => {
        const rb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, 0));
        const col = RAPIER.ColliderDesc.cuboid(thickness / 2, halfHeight, 0.25)
            .setRestitution(1)
            .setFriction(0.02);
        world.createCollider(col, rb);
    };

    // Left goal posts (leave central gap)
    makeSegment(-xOffset, gapOffset);
    makeSegment(-xOffset, -gapOffset);

    // Right goal posts (leave central gap)
    makeSegment(xOffset, gapOffset);
    makeSegment(xOffset, -gapOffset);
};

const createPaddle = side => {
    const startX = side === 'left' ? -4 : 4;

    // Mallet visual group
    const group = new THREE.Group();

    const textureLoader = new THREE.TextureLoader();
    const malletTexture = textureLoader.load('assets/mallet.png');

    // Base
    const geomBase = new THREE.CylinderGeometry(0.6, 0.6, 0.2, 32);
    const matBase = new THREE.MeshStandardMaterial({
        map: malletTexture,
        color: side === 'left' ? 0x42e8e0 : 0xff7ad1,
        roughness: 0.2,
        metalness: 0.8
    });
    const base = new THREE.Mesh(geomBase, matBase);
    base.rotation.x = Math.PI / 2;

    // Add light to mallet
    const malletLight = new THREE.PointLight(side === 'left' ? 0x42e8e0 : 0xff7ad1, 1.5, 4);
    malletLight.position.z = 0.5;
    group.add(malletLight);
    group.add(base);

    // Handle
    const geomHandle = new THREE.CylinderGeometry(0.25, 0.25, 0.4, 16);
    const matHandle = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5 });
    const handle = new THREE.Mesh(geomHandle, matHandle);
    handle.rotation.x = Math.PI / 2;
    handle.position.z = 0.2;
    group.add(handle);

    scene.add(group);

    const rbDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(startX, 0, 0);
    const rb = world.createRigidBody(rbDesc);

    // Use a ball collider for smooth interaction, effectively a cylindrical feel in 2D plane
    const col = RAPIER.ColliderDesc.ball(0.6)
        .setRestitution(0.8)
        .setFriction(0.1);
    world.createCollider(col, rb);

    return { body: rb, mesh: group, lastPos: new THREE.Vector3(startX, 0, 0) };
};

const createBall = () => {
    const textureLoader = new THREE.TextureLoader();
    const puckTexture = textureLoader.load('assets/puck.png');

    const geom = new THREE.SphereGeometry(BALL_RADIUS, 24, 24);
    const mat = new THREE.MeshStandardMaterial({
        map: puckTexture,
        color: 0xffffff,
        emissive: 0x42e8e0,
        emissiveIntensity: 0.5,
        metalness: 0.5,
        roughness: 0.2
    });
    const mesh = new THREE.Mesh(geom, mat);

    // Dynamic light on puck
    const puckLight = new THREE.PointLight(0x42e8e0, 2, 6);
    mesh.add(puckLight);

    scene.add(mesh);

    const rbDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, 0);
    const rb = world.createRigidBody(rbDesc);
    const col = RAPIER.ColliderDesc.ball(BALL_RADIUS)
        .setRestitution(1.01)
        .setFriction(0.02)
        .setDensity(0.5);
    world.createCollider(col, rb);
    rb.setLinearDamping(0.01);
    rb.setAngvel({ x: 0, y: 0, z: 1 }, true);

    return { body: rb, mesh };
};

const launchPuck = direction => {
    if (!ball.body) return;
    const dirX = Math.sign(direction) || (Math.random() > 0.5 ? 1 : -1);
    const speedX = 6.2 + Math.random() * 1.6;
    const speedY = (Math.random() - 0.5) * 3;
    ball.body.setLinvel({ x: speedX * dirX, y: speedY, z: 0 }, true);
    ball.body.setAngvel({ x: 0, y: 0, z: (Math.random() - 0.5) * 2 }, true);
    ball.body.wakeUp();
};

const resetBall = () => {
    if (!ball.body) return;
    ballActivated = false;
    ball.body.setTranslation({ x: 0, y: 0, z: 0 }, true);

    // Hover state: very slow random movement
    const angle = Math.random() * Math.PI * 2;
    const hoverSpeed = 0.5;
    ball.body.setLinvel({
        x: Math.cos(angle) * hoverSpeed,
        y: Math.sin(angle) * hoverSpeed,
        z: 0
    }, true);

    ball.body.setAngvel({ x: 0, y: 0, z: 0.5 }, true);
    setStatus('Touch the puck to start!');
};

const updatePaddleFromHand = (side, hand) => {
    const paddle = paddles[side];
    if (!paddle.body) return;

    let targetX, targetY;

    if (hand.detected) {
        // Y movement (vertical)
        targetY = clamp(hand.world.y, -TABLE_HEIGHT / 2 + 0.6, TABLE_HEIGHT / 2 - 0.6);

        // X movement (horizontal) - constrained to 1/3rd of table
        if (side === 'left') {
            // Left side: -6 to -0.6 (center line - radius)
            targetX = clamp(hand.world.x, -TABLE_WIDTH / 2 + 0.6, -0.6);
        } else {
            // Right side: 0.6 to 6
            targetX = clamp(hand.world.x, 0.6, TABLE_WIDTH / 2 - 0.6);
        }
    } else {
        // Return to default position if hand lost
        targetY = 0;
        targetX = side === 'left' ? -4 : 4;
    }

    paddle.body.setNextKinematicTranslation({ x: targetX, y: targetY, z: 0 });
    paddle.mesh.position.set(targetX, targetY, 0);
    paddle.lastPos.set(targetX, targetY, 0);
};

const syncMeshes = () => {
    if (ball.body && ball.mesh) {
        const t = ball.body.translation();
        ball.mesh.position.set(t.x, t.y, t.z);
    }
};

const ensureBallMoving = () => {
    if (!ball.body) return;
    const v = ball.body.linvel();
    const speed = Math.hypot(v.x, v.y);

    // Activation check
    if (!ballActivated) {
        // If speed increases significantly (hit by paddle), activate
        if (speed > 2.0) {
            ballActivated = true;
            setStatus('Game On!');
        } else {
            // Keep it hovering near center if not activated
            const pos = ball.body.translation();
            const dist = Math.hypot(pos.x, pos.y);
            if (dist > 1.5) {
                // Gently push back to center
                const pull = 0.05;
                ball.body.applyImpulse({ x: -pos.x * pull, y: -pos.y * pull, z: 0 }, true);
            }
            return; // Skip minimum speed checks
        }
    }

    if (speed < MIN_ACTIVE_SPEED) {
        const dirX = Math.sign(v.x) || (Math.random() > 0.5 ? 1 : -1);
        const impulse = { x: dirX * 0.9, y: (Math.random() - 0.5) * 0.6, z: 0 };
        ball.body.applyImpulse(impulse, true);
    }

    if (Math.abs(v.x) < 0.7) {
        const dirX = Math.sign(v.x) || (Math.random() > 0.5 ? 1 : -1);
        ball.body.applyImpulse({ x: dirX * 0.7, y: 0, z: 0 }, true);
    }

    if (speed > MAX_BALL_SPEED) {
        const scale = MAX_BALL_SPEED / speed;
        ball.body.setLinvel({ x: v.x * scale, y: v.y * scale, z: 0 }, true);
    }
};

const showGoalMessage = (text) => {
    const msgEl = document.getElementById('game-message');
    const txtEl = document.getElementById('message-text');
    if (msgEl && txtEl) {
        txtEl.textContent = text;
        msgEl.classList.add('visible');
        setTimeout(() => msgEl.classList.remove('visible'), 2000);
    }
};

const checkGoals = () => {
    if (!ball.body) return;
    const t = ball.body.translation();
    const withinGoal = Math.abs(t.y) <= GOAL_HEIGHT / 2;

    if (withinGoal && t.x < -TABLE_WIDTH / 2 - GOAL_MARGIN) {
        scores.right += 1;
        updateScore();
        createExplosion(t.x, t.y, 0xff7ad1);
        showGoalMessage("RIGHT SCORES!");
        resetBall();
        setStatus('Goal! Right scores. Face-off.');
    } else if (withinGoal && t.x > TABLE_WIDTH / 2 + GOAL_MARGIN) {
        scores.left += 1;
        updateScore();
        createExplosion(t.x, t.y, 0x42e8e0);
        showGoalMessage("LEFT SCORES!");
        resetBall();
        setStatus('Goal! Left scores. Face-off.');
    }
};

const drawLandmarks = results => {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    results.multiHandLandmarks.forEach(landmarks => {
        const tip = landmarks[8];
        const mirroredX = 1 - tip.x;
        const side = mirroredX < 0.5 ? 'left' : 'right';
        const color = side === 'left' ? 'rgba(66, 232, 224, 0.65)' : 'rgba(255, 122, 209, 0.65)';

        const tips = [landmarks[4], landmarks[8]];
        tips.forEach(pt => {
            ctx.beginPath();
            ctx.arc((1 - pt.x) * overlay.width, pt.y * overlay.height, 8, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
        });
    });
};

const handleHands = results => {
    handState.left.detected = false;
    handState.right.detected = false;

    results.multiHandLandmarks.forEach(landmarks => {
        const tip = landmarks[8];
        const mirroredX = 1 - tip.x;
        const handPos = normalizedToWorld(tip.x, tip.y);
        const side = mirroredX < 0.5 ? 'left' : 'right';
        const target = handState[side];
        target.detected = true;
        target.world.copy(handPos);
        target.isPinching = isPinch(landmarks);
    });

    drawLandmarks(results);
};

const animate = () => {
    updatePaddleFromHand('left', handState.left);
    updatePaddleFromHand('right', handState.right);

    world.step();
    syncMeshes();
    updateParticles();
    checkGoals();
    ensureBallMoving();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
};

const initCamera = async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
        video.srcObject = stream;
        await new Promise(res => video.onloadedmetadata = res);
        overlay.width = video.videoWidth;
        overlay.height = video.videoHeight;

        const hands = new Hands({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
        hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.65, minTrackingConfidence: 0.65 });
        hands.onResults(results => {
            handState.left.detected = false;
            handState.right.detected = false;

            if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
                ctx.clearRect(0, 0, overlay.width, overlay.height);
                return;
            }

            handleHands(results);
        });

        const cam = new Camera(video, {
            onFrame: async () => {
                await hands.send({ image: video });
            },
            width: video.videoWidth,
            height: video.videoHeight
        });
        cam.start();
    } catch (err) {
        console.error('Camera init failed:', err);
        setStatus('Camera blocked or unavailable');
    }
};

const init = async () => {
    initThree();
    initPhysics();
    setupBackgroundMusic();
    updateScore();
    setStatus('Move your hand to push the puck. Aim for the glowing goal slots.');
    await initCamera();
    resetBall();
    animate();
};

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

init();
