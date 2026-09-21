"use client";

import { motion, useReducedMotion } from "framer-motion";
import { motionTokens } from "@/lib/motion";

const particles = [
  [8, 17, 2, 0.22], [17, 74, 1, 0.14], [23, 32, 2, 0.16], [31, 12, 1, 0.2],
  [39, 68, 2, 0.13], [46, 27, 1, 0.2], [52, 85, 2, 0.16], [59, 15, 1, 0.14],
  [66, 48, 2, 0.2], [72, 78, 1, 0.16], [79, 23, 2, 0.14], [86, 61, 1, 0.22],
  [92, 35, 2, 0.15], [12, 51, 1, 0.16], [27, 91, 2, 0.12], [36, 45, 1, 0.2],
  [48, 57, 2, 0.13], [63, 91, 1, 0.18], [74, 39, 2, 0.14], [88, 88, 1, 0.2],
  [4, 63, 1, 0.14], [20, 6, 2, 0.16], [42, 38, 1, 0.14], [57, 4, 2, 0.18],
  [69, 67, 1, 0.13], [82, 7, 2, 0.16], [96, 71, 1, 0.14], [33, 82, 2, 0.14],
] as const;

export function LoginAmbient() {
  const reduced = useReducedMotion();
  return (
    <div aria-hidden="true" className="login-ambient">
      <motion.div
        className="login-blob login-blob-one"
        animate={reduced ? undefined : { x: [0, 44, 12, 0], y: [0, 24, 48, 0], scale: [1, 1.04, 0.98, 1] }}
        transition={{ duration: 20, repeat: Infinity, ease: motionTokens.ease.enter }}
      />
      <motion.div
        className="login-blob login-blob-two"
        animate={reduced ? undefined : { x: [0, -36, -12, 0], y: [0, -42, 20, 0], scale: [1, 0.97, 1.05, 1] }}
        transition={{ duration: 23, repeat: Infinity, ease: motionTokens.ease.enter }}
      />
      <motion.div
        className="login-blob login-blob-three"
        animate={reduced ? undefined : { x: [0, 24, -30, 0], y: [0, 34, 12, 0], scale: [1, 1.03, 0.97, 1] }}
        transition={{ duration: 17, repeat: Infinity, ease: motionTokens.ease.enter }}
      />
      <div className="login-particles">
        {particles.map(([left, top, size, opacity], index) => (
          <motion.i
            key={`${left}-${top}`}
            className={`login-particle ${index >= 18 ? "login-particle-desktop" : ""}`}
            style={{ left: `${left}%`, top: `${top}%`, width: size, height: size, opacity }}
            animate={reduced ? undefined : { x: [0, index % 2 ? 5 : -4, 0], y: [0, index % 3 ? -9 : 7, 0] }}
            transition={{ duration: 7 + (index % 6) * 1.35, repeat: Infinity, ease: "easeInOut" }}
          />
        ))}
      </div>
      <div className="login-overlay" />
    </div>
  );
}
