import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

interface StageOrb {
  id: string;
  label: string;
  badges: string[];
  subscribe: boolean;
}

interface CharacterStageProps {
  orbs: readonly StageOrb[];
  onBreakOrb: (orbId: string, primary: boolean) => void;
  winnerChatMessages?: readonly string[];
  winnerChatStatus?: string;
}

type AnimationKey =
  | "idle"
  | "walk"
  | "run"
  | "jump"
  | "attack"
  | "dance";

interface OrbRuntime {
  id: string;
  root: THREE.Group;
  model: THREE.Object3D;
  cracks: THREE.Object3D[];
  baseColor: THREE.Color;
  label: string;
  badges: string[];
  subscribe: boolean;
  hitCount: number;
  broken: boolean;
  lastHitAt: number;
  panel?: HTMLElement;
  glow?: THREE.PointLight;
  halo?: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  shards: Array<{
    mesh: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshStandardMaterial>;
    target: THREE.Vector3;
  }>;
  revealedAt?: number;
  primaryReveal?: boolean;
}

const MODEL_ASSET_BASE_URL = "https://orinyam0508-yt.win";
const MODEL_URL =
  import.meta.env.VITE_CHARACTER_MODEL_URL ??
  `${MODEL_ASSET_BASE_URL}/models/character.glb`;
const TARGET_MODEL_URL =
  import.meta.env.VITE_TARGET_MODEL_URL ??
  `${MODEL_ASSET_BASE_URL}/models/target.glb`;
const ATTACK_RANGE = 2.45;
const ATTACK_FORWARD_DOT = 0.38;
const MODEL_FACING_OFFSET = Math.PI;

const ANIMATION_NAMES: Record<AnimationKey, string[]> = {
  idle: ["Idle_9", "Idle_11"],
  walk: ["walking_2_inplace"],
  run: ["Skip_Forward"],
  jump: ["Regular_Jump"],
  attack: ["Right_Jab_from_Guard"],
  dance: ["Shake_It_Off_Dance"],
};

const ATTACK_ANIMATION_NAMES = [
  "Boxing_Guard_Step_Knee_Strike",
  "Right_Jab_from_Guard",
  "Boxing_Guard_Right_Straight_Kick",
];

const ORB_COLORS = [0xffffff, 0xffd6e8, 0xcfe8ff, 0xd8ffe1, 0xffefb8];
const sharedGltfLoader = new GLTFLoader();
const gltfMemoryCache = new Map<string, Promise<GLTF>>();

THREE.Cache.enabled = true;

export function CharacterStage({
  orbs,
  onBreakOrb,
  winnerChatMessages = [],
  winnerChatStatus = "idle",
}: CharacterStageProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const onBreakOrbRef = useRef(onBreakOrb);
  const [loadingMessage, setLoadingMessage] = useState("캐릭터 불러오는 중");
  const [error, setError] = useState("");

  useEffect(() => {
    onBreakOrbRef.current = onBreakOrb;
  }, [onBreakOrb]);

  useEffect(() => {
    const panel = mountRef.current?.querySelector(".orb-winner-panel.primary");
    if (!panel) return;

    const status = panel.querySelector<HTMLElement>(".orb-winner-chat-status");
    if (status) status.textContent = getChatStatusLabel(winnerChatStatus);

    const list = panel.querySelector<HTMLElement>(".orb-winner-chat-list");
    if (!list) return;
    list.replaceChildren();

    if (winnerChatMessages.length === 0) {
      const empty = document.createElement("p");
      empty.className = "orb-winner-chat-empty";
      empty.textContent = "당첨자 채팅 대기 중";
      list.appendChild(empty);
    } else {
      winnerChatMessages.slice(-8).forEach((message) => {
        const item = document.createElement("p");
        item.className = "orb-winner-chat-message";
        item.textContent = message;
        list.appendChild(item);
      });
      list.scrollTop = list.scrollHeight;
    }
  }, [winnerChatMessages, winnerChatStatus]);

  useEffect(() => {
    const mountElement = mountRef.current;
    if (!mountElement) return;
    const stageElement: HTMLElement = mountElement;

    let disposed = false;
    let animationFrame = 0;
    let mixer: THREE.AnimationMixer | null = null;
    let character: THREE.Group | null = null;
    let activeAction: THREE.AnimationAction | null = null;
    let lockedUntil = 0;
    let velocityY = 0;
    let isGrounded = true;
    let lastAttackAt = 0;
    let cameraYaw = 0;
    let cameraPitch = 0.45;
    let rightDragging = false;
    let lastPointerX = 0;
    let lastPointerY = 0;
    let attackIndex = 0;
    const clock = new THREE.Clock();
    const keys = new Set<string>();
    const actions = new Map<AnimationKey, THREE.AnimationAction>();
    const attackActions: THREE.AnimationAction[] = [];
    let danceAction: THREE.AnimationAction | null = null;
    const orbRuntimes: OrbRuntime[] = [];

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07101f);
    scene.fog = new THREE.Fog(0x07101f, 26, 58);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 120);
    camera.position.set(0, 4.2, 8.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mountElement.appendChild(renderer.domElement);

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xa8c5d7, 1.44);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.92);
    keyLight.position.set(6, 10, 8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x9fcfff, 0.96);
    fillLight.position.set(-6, 5, -4);
    scene.add(fillLight);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(42, 42),
      new THREE.MeshStandardMaterial({
        map: createMarbleTexture(),
        color: 0xcbd5df,
        roughness: 0.34,
        metalness: 0.03,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    createNightRoom().forEach((object) => scene.add(object));

    const orbPositions = createOrbPositions(orbs.length);

    function addTargetRuntimes(targetModel: THREE.Object3D | null) {
      if (disposed || orbRuntimes.length > 0) return;

      orbs.forEach((orb, index) => {
        const runtime = createOrb(
          orb.id,
          orb.label,
          orb.badges,
          orb.subscribe,
          orbPositions[index],
          ORB_COLORS[index % ORB_COLORS.length],
          targetModel
        );
        orbRuntimes.push(runtime);
        scene.add(runtime.root);
        runtime.panel = createWinnerPanelElement(runtime, false);
        runtime.panel.classList.add("preloaded");
        stageElement.appendChild(runtime.panel);
      });
    }

    function resize() {
      const width = mountElement!.clientWidth || 1;
      const height = mountElement!.clientHeight || 1;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    }

    function pickAction(key: AnimationKey) {
      return actions.get(key) ?? actions.get("idle") ?? null;
    }

    function playAnimation(key: AnimationKey, fade = 0.18) {
      const nextAction = pickAction(key);
      if (!nextAction || activeAction === nextAction) return;

      nextAction.enabled = true;
      nextAction.reset();
      nextAction.fadeIn(fade);
      nextAction.play();
      activeAction?.fadeOut(fade);
      activeAction = nextAction;
    }

    function playOneShot(key: AnimationKey, durationMs: number) {
      const action = pickAction(key);
      if (!action) return;

      playActionOnce(action, durationMs);
    }

    function playActionOnce(action: THREE.AnimationAction, durationMs: number) {
      lockedUntil = performance.now() + durationMs;
      action.reset();
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.fadeIn(0.08);
      action.play();
      activeAction?.fadeOut(0.08);
      activeAction = action;
    }

    function handleAttack() {
      const now = performance.now();
      if (!character || now - lastAttackAt < 420) return;

      lastAttackAt = now;
      playAttackSound();
      const attackAction = attackActions[attackIndex % attackActions.length];
      attackIndex += 1;
      if (attackAction) {
        playActionOnce(attackAction, 650);
      } else {
        playOneShot("attack", 650);
      }

          const target = findAttackTarget(character, orbRuntimes, cameraYaw);
      if (!target) return;

      playOrbHitSound(target.hitCount + 1);
      target.hitCount += 1;
      target.lastHitAt = performance.now();
      applyOrbDamage(target);

      if (target.hitCount >= 3 && !target.broken) {
        revealOrb(target, true);
        playDance();
        orbRuntimes
          .filter((orb) => !orb.broken)
          .forEach((orb, index) => {
            window.setTimeout(() => revealOrb(orb, false), 220 + index * 180);
          });
      }
    }

    function revealOrb(orb: OrbRuntime, primary: boolean) {
      if (orb.broken) return;
      orb.hitCount = 3;
      orb.broken = true;
      breakOrb(orb, primary, stageElement);
      window.setTimeout(() => {
        onBreakOrbRef.current(orb.id, primary);
      }, 520);
    }

    function playDance() {
      if (!danceAction) {
        playOneShot("dance", 4_600);
        return;
      }

      const durationMs = Math.max(1_800, danceAction.getClip().duration * 1_000);
      playActionOnce(danceAction, durationMs);
    }

    function animate() {
      if (disposed) return;

      const delta = Math.min(clock.getDelta(), 0.05);
      const now = performance.now();
      mixer?.update(delta);

      if (character) {
        const forwardPressed = keys.has("keyw") || keys.has("arrowup");
        const backwardPressed = keys.has("keys") || keys.has("arrowdown");
        const leftPressed = keys.has("keya") || keys.has("arrowleft");
        const rightPressed = keys.has("keyd") || keys.has("arrowright");
        const running = keys.has("shiftleft") || keys.has("shiftright");
        const inputLocked = now < lockedUntil;

        if (!inputLocked) {
          const cameraForward = new THREE.Vector3(
            -Math.sin(cameraYaw),
            0,
            -Math.cos(cameraYaw)
          ).normalize();
          const cameraRight = new THREE.Vector3(
            -cameraForward.z,
            0,
            cameraForward.x
          ).normalize();
          const moveDirection = new THREE.Vector3();
          if (forwardPressed) moveDirection.add(cameraForward);
          if (backwardPressed) moveDirection.sub(cameraForward);
          if (leftPressed) moveDirection.sub(cameraRight);
          if (rightPressed) moveDirection.add(cameraRight);

          if (moveDirection.lengthSq() > 0) {
            const speed = running ? 5.2 : 2.35;
            moveDirection.normalize();
            const targetYaw =
              Math.atan2(-moveDirection.x, -moveDirection.z) +
              MODEL_FACING_OFFSET;
            character.rotation.y = lerpAngle(
              character.rotation.y,
              targetYaw,
              1 - Math.exp(-12 * delta)
            );
            character.position.addScaledVector(moveDirection, speed * delta);
          }

          if (moveDirection.lengthSq() > 0) {
            playAnimation(running ? "run" : "walk");
          } else {
            playAnimation("idle");
          }
        }

        velocityY -= 14 * delta;
        character.position.y = Math.max(0, character.position.y + velocityY * delta);
        if (character.position.y <= 0) {
          character.position.y = 0;
          velocityY = 0;
          isGrounded = true;
        }

        character.position.x = THREE.MathUtils.clamp(character.position.x, -15, 15);
        character.position.z = THREE.MathUtils.clamp(character.position.z, -13, 10);

        const cameraDistance = 7;
        const minCameraY = 0.28;
        const rawCameraY =
          character.position.y +
          Math.sin(cameraPitch) * cameraDistance +
          1.2;
        const floorPushIn =
          rawCameraY < minCameraY
            ? Math.min(0.42, (minCameraY - rawCameraY) / 4.2)
            : 0;
        const effectiveCameraDistance = cameraDistance * (1 - floorPushIn);
        const back = new THREE.Vector3(
          Math.sin(cameraYaw) * Math.cos(cameraPitch) * effectiveCameraDistance,
          Math.sin(cameraPitch) * effectiveCameraDistance + 1.2,
          Math.cos(cameraYaw) * Math.cos(cameraPitch) * effectiveCameraDistance
        );
        const targetCamera = character.position.clone().add(back);
        targetCamera.y = Math.max(targetCamera.y, minCameraY);
        camera.position.lerp(targetCamera, 1 - Math.exp(-5.5 * delta));
        const lookAt = character.position.clone().add(new THREE.Vector3(0, 1.25, 0));
        camera.lookAt(lookAt);
      }

      orbRuntimes.forEach((orb) => {
        if (orb.broken) return;
        const pulse = Math.sin(now * 0.003 + orb.root.position.x) * 0.025;
        const hitAge = now - orb.lastHitAt;
        const hitShake =
          hitAge < 360
            ? Math.sin(now * 0.09) * (1 - hitAge / 360) * 0.18
            : 0;
        const damageShake = orb.hitCount > 0 ? Math.sin(now * 0.025) * 0.01 * orb.hitCount : 0;
        const scale = 1 + pulse + damageShake;
        orb.root.scale.setScalar(scale);
        orb.model.rotation.z = hitShake;
        orb.model.rotation.x = -hitShake * 0.55;
      });

      orbRuntimes.forEach((orb) => {
        if (!orb.panel || !orb.revealedAt) return;
        const progress = Math.min(1, (now - orb.revealedAt) / 720);
        const eased = 1 - Math.pow(1 - progress, 3);
        const panelPosition = orb.root.position.clone();
        panelPosition.y += 0.75 + eased * 1.75;
        panelPosition.project(camera);
        const x = (panelPosition.x * 0.5 + 0.5) * stageElement.clientWidth;
        const y = (-panelPosition.y * 0.5 + 0.5) * stageElement.clientHeight;
        orb.panel.style.opacity = panelPosition.z < 1 ? "1" : "0";
        orb.panel.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${0.82 + eased * 0.18})`;
        if (orb.glow) {
          orb.glow.intensity = 1.6 + Math.sin(now * 0.006) * 0.35;
        }
        if (orb.halo) {
          orb.halo.material.opacity = 0.68 + Math.sin(now * 0.005) * 0.12;
        }
        const shardProgress = Math.min(1, (now - orb.revealedAt) / 520);
        orb.shards.forEach(({ mesh, target }, index) => {
          mesh.position.copy(target).multiplyScalar(shardProgress);
          mesh.rotation.x += 0.08 + index * 0.002;
          mesh.rotation.y += 0.11 + index * 0.002;
          mesh.material.opacity = 0.9 * (1 - shardProgress);
          if (shardProgress >= 1) {
            mesh.visible = false;
          }
        });
      });

      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(animate);
    }

    function handleKeyDown(event: KeyboardEvent) {
      const code = event.code.toLowerCase();
      keys.add(code);
      if (["space", "keyw", "keya", "keys", "keyd", "keyj", "keyf"].includes(code)) {
        event.preventDefault();
      }
      if (!character) return;
      if (code === "space" && isGrounded) {
        isGrounded = false;
        velocityY = 5.6;
        playOneShot("jump", 700);
      }
      if (code === "keyj") {
        handleAttack();
      }
      if (code === "keyf") {
        playDance();
      }
    }

    function handleKeyUp(event: KeyboardEvent) {
      keys.delete(event.code.toLowerCase());
    }

    function handlePointerDown(event: PointerEvent) {
      if (event.button === 2) {
        rightDragging = true;
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
        renderer.domElement.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }

      if (event.button === 0) {
        handleAttack();
      }
    }

    function handlePointerMove(event: PointerEvent) {
      if (!rightDragging) return;

      const deltaX = event.clientX - lastPointerX;
      const deltaY = event.clientY - lastPointerY;
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;

      cameraYaw -= deltaX * 0.006;
      cameraPitch = THREE.MathUtils.clamp(
        cameraPitch + deltaY * 0.004,
        -1.05,
        1.18
      );
    }

    function handlePointerUp(event: PointerEvent) {
      if (event.button !== 2) return;
      rightDragging = false;
      renderer.domElement.releasePointerCapture(event.pointerId);
    }

    function handleContextMenu(event: MouseEvent) {
      event.preventDefault();
    }

    window.addEventListener("resize", resize);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("contextmenu", handleContextMenu);
    resize();

    loadCachedGltf(TARGET_MODEL_URL)
      .then((gltf) => {
        addTargetRuntimes(gltf.scene);
      })
      .catch(() => {
        addTargetRuntimes(null);
      });

    loadCachedGltf(MODEL_URL)
      .then((gltf) => {
        if (disposed) return;
        character = cloneStageModel(gltf.scene) as THREE.Group;
        character.position.set(0, 0, 4.2);
        character.rotation.y = cameraYaw + MODEL_FACING_OFFSET;

        const box = new THREE.Box3().setFromObject(character);
        const size = box.getSize(new THREE.Vector3());
        const height = size.y || 1;
        const targetHeight = 2.35;
        character.scale.setScalar(Math.min(targetHeight / height, 1));
        const scaledBox = new THREE.Box3().setFromObject(character);
        character.position.y -= scaledBox.min.y;

        character.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.castShadow = true;
            object.receiveShadow = true;
            const materials = Array.isArray(object.material)
              ? object.material
              : [object.material];
            materials.forEach((material) => {
              material.transparent = false;
              material.opacity = 1;
              material.depthWrite = true;
              material.side = THREE.FrontSide;
              material.needsUpdate = true;
            });
          }
        });

        mixer = new THREE.AnimationMixer(character);
        for (const key of Object.keys(ANIMATION_NAMES) as AnimationKey[]) {
          const clip = findClip(gltf.animations, ANIMATION_NAMES[key]);
          if (!clip) continue;
          const action = mixer.clipAction(clip);
          if (key === "jump" || key === "attack" || key === "dance") {
            action.setLoop(THREE.LoopOnce, 1);
            action.clampWhenFinished = true;
          }
          actions.set(key, action);
          if (key === "dance") {
            danceAction = action;
          }
        }
        ATTACK_ANIMATION_NAMES.forEach((name) => {
          const clip = gltf.animations.find((animation) => animation.name === name);
          if (!clip || !mixer) return;
          const action = mixer.clipAction(clip);
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
          attackActions.push(action);
        });

        scene.add(character);
        playAnimation("idle", 0);
        setLoadingMessage("");
      })
      .catch(() => {
        if (!disposed) {
          setLoadingMessage("");
          setError("캐릭터 모델을 불러오지 못했습니다.");
        }
      });

    animate();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("contextmenu", handleContextMenu);
      renderer.dispose();
      orbRuntimes.forEach((orb) => {
        orb.panel?.remove();
      });
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          if (!object.userData.cachedGltfGeometry) {
            object.geometry.dispose();
          }
          const materials = Array.isArray(object.material)
            ? object.material
            : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      mountElement.removeChild(renderer.domElement);
    };
  }, [orbs]);

  return (
    <div className="character-stage">
      <div className="character-canvas" ref={mountRef} />
      <div className="character-controls">
        <span>우클릭 드래그 카메라</span>
        <span>W/A/S/D 이동</span>
        <span>Shift 달리기</span>
        <span>Space 점프</span>
        <span>J/좌클릭 공격</span>
        <span>F 춤추기</span>
      </div>
      {loadingMessage ? (
        <div className="character-stage-message">{loadingMessage}</div>
      ) : null}
      {error ? <div className="character-stage-message error">{error}</div> : null}
    </div>
  );
}

function findClip(clips: THREE.AnimationClip[], names: readonly string[]) {
  return names
    .map((name) => clips.find((clip) => clip.name === name))
    .find((clip): clip is THREE.AnimationClip => Boolean(clip));
}

function loadCachedGltf(url: string) {
  const cached = gltfMemoryCache.get(url);
  if (cached) return cached;

  const request = new Promise<GLTF>((resolve, reject) => {
    sharedGltfLoader.load(url, resolve, undefined, reject);
  }).catch((error) => {
    gltfMemoryCache.delete(url);
    throw error;
  });

  gltfMemoryCache.set(url, request);
  return request;
}

function cloneStageModel(source: THREE.Object3D) {
  const cloned = cloneSkeleton(source);

  cloned.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.userData.cachedGltfGeometry = true;
    object.material = Array.isArray(object.material)
      ? object.material.map((material) => material.clone())
      : object.material.clone();
  });

  return cloned;
}

function lerpAngle(current: number, target: number, alpha: number) {
  const delta =
    ((((target - current) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) -
    Math.PI;
  return current + delta * alpha;
}

function createOrbPositions(count: number) {
  const spacing = 2.05 * 1.3;
  const start = -((count - 1) * spacing) / 2;

  return Array.from({ length: count }, (_, index) => {
    const x = start + index * spacing;
    const z = -3.2 - Math.abs(index - (count - 1) / 2) * 0.45;
    return new THREE.Vector3(x, 0.35, z);
  });
}

function createOrb(
  id: string,
  label: string,
  badges: string[],
  subscribe: boolean,
  position: THREE.Vector3,
  colorValue: number,
  targetModel: THREE.Object3D | null
): OrbRuntime {
  const root = new THREE.Group();
  root.position.copy(position);
  const baseColor = new THREE.Color(colorValue);

  const model = targetModel
    ? cloneStageModel(targetModel)
    : createFallbackTargetModel(baseColor);
  prepareTargetModel(model, baseColor);
  root.add(model);

  const cracks: THREE.Object3D[] = [];
  for (let index = 0; index < 5; index += 1) {
    const crack = new THREE.Mesh(
      new THREE.TorusGeometry(0.48 + index * 0.035, 0.012, 8, 44, Math.PI * 1.25),
      new THREE.MeshBasicMaterial({
        color: 0x8aa4b8,
        transparent: true,
        opacity: 0,
      })
    );
    crack.rotation.set(
      Math.random() * Math.PI,
      Math.random() * Math.PI,
      Math.random() * Math.PI
    );
    cracks.push(crack);
    root.add(crack);
  }

  const revealLight = new THREE.PointLight(0xffd66d, 0, 7);
  revealLight.position.set(0, 1.2, 0);
  root.add(revealLight);

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.95, 1.18, 56),
    new THREE.MeshBasicMaterial({
      color: 0xffd66d,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.05;
  halo.visible = false;
  root.add(halo);

  const shards = Array.from({ length: 8 }, () => {
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.08 + Math.random() * 0.08, 0),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.35,
        transparent: true,
        opacity: 0,
      })
    );
    mesh.visible = false;
    root.add(mesh);

    const target = new THREE.Vector3(
      Math.random() - 0.5,
      Math.random() * 0.8 + 0.25,
      Math.random() - 0.5
    )
      .normalize()
      .multiplyScalar(0.55 + Math.random() * 0.8);

    return { mesh, target };
  });

  return {
    id,
    root,
    model,
    cracks,
    baseColor,
    label,
    badges,
    subscribe,
    glow: revealLight,
    halo,
    shards,
    hitCount: 0,
    lastHitAt: 0,
    broken: false,
  };
}

function createFallbackTargetModel(color: THREE.Color) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.72, 48, 32),
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.42,
      metalness: 0.02,
      transparent: true,
      opacity: 0.96,
    })
  );
}

function prepareTargetModel(model: THREE.Object3D, color: THREE.Color) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxAxis = Math.max(size.x, size.y, size.z, 1);
  const targetSize = 1.74;
  model.scale.multiplyScalar(targetSize / maxAxis);

  const scaledBox = new THREE.Box3().setFromObject(model);
  const center = scaledBox.getCenter(new THREE.Vector3());
  model.position.sub(center);
  model.position.y -= scaledBox.min.y - center.y;

  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    materials.forEach((material) => {
      if ("color" in material && material.color instanceof THREE.Color) {
        material.color.lerp(color, 0.18);
      }
      material.transparent = false;
      material.opacity = 1;
      material.depthWrite = true;
      material.needsUpdate = true;
    });
  });
}

function createMarbleTexture() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const gradient = context.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, "#d9e0e8");
  gradient.addColorStop(0.5, "#b8c4cf");
  gradient.addColorStop(1, "#e2e7ed");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  for (let index = 0; index < 38; index += 1) {
    const y = Math.random() * size;
    context.beginPath();
    context.moveTo(-40, y);
    for (let x = -40; x <= size + 40; x += 38) {
      context.lineTo(x, y + Math.sin(x * 0.018 + index) * 24 + Math.random() * 18);
    }
    context.strokeStyle = `rgba(${130 + Math.random() * 50}, ${150 + Math.random() * 50}, ${170 + Math.random() * 50}, ${0.08 + Math.random() * 0.12})`;
    context.lineWidth = 1 + Math.random() * 2.4;
    context.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5, 5);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createNightRoom() {
  const texture = createNightSkyTexture();
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.BackSide,
  });
  const room = new THREE.Mesh(new THREE.BoxGeometry(42, 22, 42), material);
  room.position.y = 10.9;

  return [room];
}

function createNightSkyTexture() {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#030712");
  gradient.addColorStop(0.56, "#0b1740");
  gradient.addColorStop(1, "#142957");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  for (let index = 0; index < 420; index += 1) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    const radius = Math.random() * 1.6 + 0.25;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = `rgba(255,255,255,${0.35 + Math.random() * 0.65})`;
    context.fill();
  }

  for (let index = 0; index < 24; index += 1) {
    const x = Math.random() * width;
    const y = Math.random() * height * 0.72;
    context.beginPath();
    context.moveTo(x - 8, y);
    context.lineTo(x + 8, y);
    context.moveTo(x, y - 8);
    context.lineTo(x, y + 8);
    context.strokeStyle = "rgba(255,255,255,.42)";
    context.lineWidth = 1;
    context.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createWinnerPanelElement(orb: OrbRuntime, primary: boolean) {
  const panel = document.createElement("div");
  panel.className = `orb-winner-panel ${primary ? "primary" : ""}`;

  if (primary) {
    const title = document.createElement("div");
    title.className = "orb-winner-title";
    title.textContent = "당첨자";
    panel.appendChild(title);
  }

  const chip = document.createElement("div");
  chip.className = "viewer-chip orb-winner-chip";

  orb.badges.forEach((badge, index) => {
    const image = document.createElement("img");
    image.src = badge;
    image.alt = "";
    image.decoding = "async";
    image.loading = "eager";
    image.dataset.index = String(index);
    chip.appendChild(image);
  });

  const name = document.createElement("span");
  name.textContent = orb.label;
  chip.appendChild(name);

  if (orb.subscribe) {
    const subscribe = document.createElement("b");
    subscribe.textContent = "구독";
    chip.appendChild(subscribe);
  }

  panel.appendChild(chip);

  if (primary) {
    const chat = document.createElement("div");
    chat.className = "orb-winner-chat";

    const header = document.createElement("div");
    header.className = "orb-winner-chat-header";
    const title = document.createElement("strong");
    title.textContent = "당첨자 채팅";
    const status = document.createElement("span");
    status.className = "orb-winner-chat-status";
    status.textContent = getChatStatusLabel("connecting");
    header.append(title, status);

    const list = document.createElement("div");
    list.className = "orb-winner-chat-list";
    const empty = document.createElement("p");
    empty.className = "orb-winner-chat-empty";
    empty.textContent = "당첨자 채팅 대기 중";
    list.appendChild(empty);

    chat.append(header, list);
    panel.appendChild(chat);
  }

  return panel;
}

function ensurePrimaryWinnerPanel(panel: HTMLElement) {
  if (!panel.querySelector(".orb-winner-title")) {
    const title = document.createElement("div");
    title.className = "orb-winner-title";
    title.textContent = "당첨자";
    panel.prepend(title);
  }

  if (panel.querySelector(".orb-winner-chat")) return;

  const chat = document.createElement("div");
  chat.className = "orb-winner-chat";

  const header = document.createElement("div");
  header.className = "orb-winner-chat-header";
  const title = document.createElement("strong");
  title.textContent = "당첨자 채팅";
  const status = document.createElement("span");
  status.className = "orb-winner-chat-status";
  status.textContent = getChatStatusLabel("connecting");
  header.append(title, status);

  const list = document.createElement("div");
  list.className = "orb-winner-chat-list";
  const empty = document.createElement("p");
  empty.className = "orb-winner-chat-empty";
  empty.textContent = "당첨자 채팅 대기 중";
  list.appendChild(empty);

  chat.append(header, list);
  panel.appendChild(chat);
}

function getChatStatusLabel(status: string) {
  const labels: Record<string, string> = {
    idle: "연결 대기",
    connecting: "연결 중",
    connected: "채팅 연결됨",
    error: "연결 오류",
  };

  return labels[status] ?? status;
}

function findAttackTarget(
  character: THREE.Group,
  orbs: readonly OrbRuntime[],
  facingYaw: number
) {
  const forward = new THREE.Vector3(
    -Math.sin(facingYaw),
    0,
    -Math.cos(facingYaw)
  ).normalize();
  const origin = character.position.clone();

  return orbs
    .filter((orb) => !orb.broken)
    .map((orb) => {
      const toOrb = orb.root.position.clone().sub(origin);
      toOrb.y = 0;
      const distance = toOrb.length();
      const dot = distance > 0 ? forward.dot(toOrb.normalize()) : 1;
      return { orb, distance, dot };
    })
    .filter(({ distance, dot }) => distance <= ATTACK_RANGE && dot >= ATTACK_FORWARD_DOT)
    .sort((left, right) => left.distance - right.distance)[0]?.orb;
}

function applyOrbDamage(orb: OrbRuntime) {
  const damageRatio = Math.min(orb.hitCount, 3) / 3;
  orb.model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    materials.forEach((material) => {
      if ("color" in material && material.color instanceof THREE.Color) {
        material.color.lerp(new THREE.Color(0x8ea6b9), damageRatio * 0.12);
      }
    });
  });
  orb.cracks.forEach((crack, index) => {
    const material = (crack as THREE.Mesh).material as THREE.MeshBasicMaterial;
    material.opacity = index < orb.hitCount * 2 ? 0.72 : 0;
  });
}

function breakOrb(orb: OrbRuntime, primary: boolean, mountElement: HTMLElement) {
  orb.model.visible = false;
  orb.cracks.forEach((crack) => {
    crack.visible = false;
  });
  orb.revealedAt = performance.now();
  orb.primaryReveal = primary;

  const panel = orb.panel ?? createWinnerPanelElement(orb, false);
  orb.panel = panel;
  panel.classList.remove("preloaded");
  panel.classList.toggle("primary", primary);
  if (primary) {
    ensurePrimaryWinnerPanel(panel);
  }
  if (!panel.parentElement) {
    mountElement.appendChild(panel);
  }

  if (orb.glow) {
    orb.glow.intensity = 2.1;
  }
  if (orb.halo) {
    orb.halo.visible = true;
    orb.halo.material.opacity = 0.72;
  }
  orb.shards.forEach(({ mesh }) => {
    mesh.visible = true;
    mesh.position.set(0, 0, 0);
    mesh.material.opacity = 0.9;
  });
}

let audioContext: AudioContext | null = null;

function getAudioContext() {
  const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextConstructor) return null;

  audioContext ??= new AudioContextConstructor();
  if (audioContext.state === "suspended") {
    void audioContext.resume();
  }

  return audioContext;
}

function playAttackSound() {
  const context = getAudioContext();
  if (!context) return;

  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(260, now);
  oscillator.frequency.exponentialRampToValueAtTime(92, now + 0.12);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.18);
}

function playOrbHitSound(hitNumber: number) {
  const context = getAudioContext();
  if (!context) return;

  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const peak = hitNumber >= 3 ? 0.28 : 0.2;
  const startFrequency = hitNumber >= 3 ? 760 : 560;

  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(startFrequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(150, now + 0.1);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.22);

  if (hitNumber >= 3) {
    playBreakNoise(context, now);
  }
}

function playBreakNoise(context: AudioContext, startTime: number) {
  const duration = 0.24;
  const sampleRate = context.sampleRate;
  const buffer = context.createBuffer(1, sampleRate * duration, sampleRate);
  const channel = buffer.getChannelData(0);

  for (let index = 0; index < channel.length; index += 1) {
    channel[index] = (Math.random() * 2 - 1) * (1 - index / channel.length);
  }

  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();

  filter.type = "highpass";
  filter.frequency.value = 900;
  gain.gain.setValueAtTime(0.16, startTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  source.buffer = buffer;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(context.destination);
  source.start(startTime);
}
