"use client";

import Image from "next/image";
import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import styles from "./valurise-splash.module.css";

export type ValuriseSplashStatus = "opening" | "syncing" | "ready" | "error";

type ValuriseSplashProps = {
  status: ValuriseSplashStatus;
  onComplete: () => void;
};

const easing = [0.22, 1, 0.36, 1] as const;

export function ValuriseSplash({ status, onComplete }: ValuriseSplashProps) {
  const systemReducedMotion = useReducedMotion();
  const [hasHydrated, setHasHydrated] = useState(false);
  const reducedMotion = hasHydrated && Boolean(systemReducedMotion);
  const [introComplete, setIntroComplete] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [exitComplete, setExitComplete] = useState(false);
  const completed = useRef(false);

  useEffect(() => setHasHydrated(true), []);

  useEffect(() => {
    if (reducedMotion) setIntroComplete(true);
  }, [reducedMotion]);

  useEffect(() => {
    if (status === "error") {
      setExitComplete(true);
      return;
    }
    if (status === "ready" && introComplete) {
      if (reducedMotion) setExitComplete(true);
      else setRevealing(true);
    }
  }, [introComplete, reducedMotion, status]);

  const waiting = !reducedMotion && introComplete && (status === "opening" || status === "syncing") && !revealing;
  const statusText =
    status === "syncing"
      ? "Sincronizando sua conta…"
      : status === "error"
        ? "Não foi possível confirmar seus dados."
        : "Abrindo sua conta…";

  function finish() {
    if (completed.current) return;
    completed.current = true;
    onComplete();
  }

  return (
    <motion.div
      className={`${styles.splash} ${revealing ? styles.revealing : ""}`}
      initial={{ opacity: 1 }}
      animate={{ opacity: exitComplete ? 0 : 1 }}
      transition={{ duration: exitComplete ? 0.14 : 0, ease: easing }}
      onAnimationComplete={() => {
        if (exitComplete) finish();
      }}
    >
      {revealing && !reducedMotion && (
        <motion.svg
          className={styles.revealCurtain}
          data-testid="splash-reveal-mask"
          viewBox="0 0 512 512"
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ opacity: { duration: 0.14, delay: 0.42, ease: easing } }}
          onAnimationComplete={() => setExitComplete(true)}
        >
          <defs>
            <filter id="valurise-splash-blacken" colorInterpolationFilters="sRGB">
              <feComponentTransfer>
                <feFuncR type="linear" slope="0" />
                <feFuncG type="linear" slope="0" />
                <feFuncB type="linear" slope="0" />
              </feComponentTransfer>
            </filter>
            <mask
              id="valurise-splash-mark-mask"
              x="0"
              y="0"
              width="512"
              height="512"
              maskUnits="userSpaceOnUse"
              style={{ maskType: "luminance" }}
            >
              <rect width="512" height="512" fill="white" />
              <motion.g
                initial={{ scale: 0.16 }}
                animate={{ scale: 3.4 }}
                transition={{ duration: 0.54, ease: easing }}
                style={{ transformBox: "view-box", transformOrigin: "50% 50%" }}
              >
                <image
                  href="/valurise-icon.webp"
                  width="512"
                  height="512"
                  filter="url(#valurise-splash-blacken)"
                />
              </motion.g>
            </mask>
          </defs>
          <rect width="512" height="512" fill="#12131a" mask="url(#valurise-splash-mark-mask)" />
        </motion.svg>
      )}

      <motion.div
        className={styles.brandContent}
        animate={{ opacity: revealing || exitComplete ? 0 : 1 }}
        transition={{ duration: 0.16, ease: easing }}
      >
        <motion.div
          className={styles.mark}
          data-testid="splash-mark"
          initial={reducedMotion ? false : { opacity: 1, scale: 0.96 }}
          animate={{ opacity: 1, scale: waiting ? [1, 1.015, 1] : 1 }}
          transition={
            reducedMotion
              ? { duration: 0 }
              : waiting
              ? { opacity: { duration: 0.2 }, scale: { duration: 2.1, repeat: Infinity, ease: "easeInOut" } }
              : { opacity: { duration: 0.2 }, scale: { duration: 0.72, ease: easing } }
          }
          aria-hidden="true"
        >
          {!reducedMotion && !introComplete && (
            <>
              <motion.span
                className={`${styles.fragment} ${styles.fragmentLeft}`}
                initial={{ opacity: 0.18, x: -7, y: 3 }}
                animate={{ opacity: 0.9, x: 0, y: 0 }}
                transition={{ duration: 0.46, ease: easing }}
              />
              <motion.span
                className={`${styles.fragment} ${styles.fragmentRight}`}
                initial={{ opacity: 0.18, x: 7, y: -3 }}
                animate={{ opacity: 0.9, x: 0, y: 0 }}
                transition={{ duration: 0.46, delay: 0.08, ease: easing }}
              />
            </>
          )}
          <motion.div
            className={styles.completeMark}
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: reducedMotion ? 0 : 0.3, delay: reducedMotion ? 0 : 0.43, ease: easing }}
            onAnimationComplete={() => setIntroComplete(true)}
          >
            <Image
              src="/valurise-icon.webp"
              alt=""
              aria-hidden="true"
              fill
              sizes="(max-width: 480px) 88px, 112px"
              className={styles.logoImage}
              preload
            />
          </motion.div>
        </motion.div>

        <motion.p
          className={styles.wordmark}
          initial={reducedMotion ? false : { opacity: 0, y: 3 }}
          animate={{ opacity: revealing || exitComplete ? 0 : 1, y: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.22, delay: reducedMotion ? 0 : 0.58, ease: easing }}
        >
          VALURISE
        </motion.p>
        <p className={styles.status} aria-live="polite" aria-atomic="true">
          {statusText}
        </p>
      </motion.div>
    </motion.div>
  );
}
