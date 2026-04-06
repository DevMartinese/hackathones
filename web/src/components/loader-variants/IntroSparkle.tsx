import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { Group } from "three";
import { ShaderCanvas, SparkleShape } from "./shared";

// Lerp factor per second. Higher = decelerates faster.
const REST_DAMPING = 7;

function RotatingSparkle({ paused }: { paused: boolean }) {
  const ref = useRef<Group>(null);
  useFrame((_, delta) => {
    const g = ref.current;
    if (!g) return;
    if (paused) {
      const t = Math.min(delta * REST_DAMPING, 1);
      g.rotation.x += (0 - g.rotation.x) * t;
      g.rotation.z += (0 - g.rotation.z) * t;
      // Snap Y to the nearest full-face pose (multiple of 2π) so the
      // sparkle always rests facing the camera straight-on.
      const TAU = Math.PI * 2;
      const target = Math.round(g.rotation.y / TAU) * TAU;
      g.rotation.y += (target - g.rotation.y) * t;
    } else {
      // Coin flip — rotate around the vertical axis passing through
      // the top/bottom big tips.
      g.rotation.y += delta * 1.6;
    }
  });
  return (
    <group ref={ref}>
      <SparkleShape />
    </group>
  );
}

export default function IntroSparkle({
  paused = false,
  onReady,
}: {
  paused?: boolean;
  onReady?: () => void;
}) {
  return (
    <ShaderCanvas effect="etch" onReady={onReady}>
      <RotatingSparkle paused={paused} />
    </ShaderCanvas>
  );
}
