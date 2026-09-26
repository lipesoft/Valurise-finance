"use client";

import Image from "next/image";
import { useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState, type TransitionEvent } from "react";
import styles from "./valurise-splash.module.css";

export type ValuriseSplashStatus = "opening" | "syncing" | "ready" | "error";

type ValuriseSplashProps = {
  status: ValuriseSplashStatus;
  onComplete: () => void;
};

export function ValuriseSplash({ status, onComplete }: ValuriseSplashProps) {
  const systemReducedMotion = useReducedMotion();
  const [hasHydrated, setHasHydrated] = useState(false);
  const reducedMotion = hasHydrated && Boolean(systemReducedMotion);
  const [introComplete, setIntroComplete] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [exitComplete, setExitComplete] = useState(false);
  const completed = useRef(false);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  useEffect(() => {
    if (reducedMotion) setIntroComplete(true);
  }, [reducedMotion]);

  useEffect(() => {
    if (introComplete || reducedMotion) return;
    // This is only a minimum intro-animation fallback; loading status remains driven by auth/sync.
    const fallback = window.setTimeout(() => setIntroComplete(true), 820);
    return () => window.clearTimeout(fallback);
  }, [introComplete, reducedMotion]);

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

  const waiting =
    !reducedMotion && introComplete && (status === "opening" || status === "syncing") && !revealing;
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

  function handleRootTransitionEnd(event: TransitionEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && event.propertyName === "opacity" && exitComplete) finish();
  }

  function handleMarkTransitionEnd(event: TransitionEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && event.propertyName === "transform" && revealing && status === "ready") {
      setExitComplete(true);
    }
  }

  return (
    <div
      className={`${styles.splash} ${revealing ? styles.revealing : ""} ${exitComplete ? styles.exiting : ""}`}
      onTransitionEnd={handleRootTransitionEnd}
    >
      <div className={styles.brandContent}>
        <div
          className={`${styles.mark} ${waiting ? styles.waiting : ""} ${introComplete ? styles.formed : ""}`}
          data-testid="splash-mark"
          data-state={revealing ? "revealing" : status}
          data-intro-complete={String(introComplete)}
          onTransitionEnd={handleMarkTransitionEnd}
          aria-hidden="true"
        >
          {!reducedMotion && !introComplete && (
            <>
              <span className={`${styles.fragment} ${styles.fragmentLeft}`} />
              <span className={`${styles.fragment} ${styles.fragmentRight}`} />
            </>
          )}
          <div
            className={`${styles.completeMark} ${reducedMotion ? "" : styles.enteringMark}`}
            onAnimationEnd={() => setIntroComplete(true)}
          >
            <Image
              src="/valurise-icon.webp"
              alt=""
              aria-hidden="true"
              width={192}
              height={192}
              sizes="(max-width: 480px) 40vw, 192px"
              className={styles.logoImage}
              preload
            />
          </div>
          {!reducedMotion && <span className={styles.markHighlight} />}
        </div>

        <p className={styles.wordmark}>VALURISE</p>
        <p className={styles.status} aria-live="polite" aria-atomic="true">
          {statusText}
        </p>
      </div>
    </div>
  );
}
