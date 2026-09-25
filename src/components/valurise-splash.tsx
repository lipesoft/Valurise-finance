"use client";

import Image from "next/image";
import { useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState, type CSSProperties, type TransitionEvent } from "react";
import styles from "./valurise-splash.module.css";

export type ValuriseSplashStatus = "opening" | "syncing" | "ready" | "error";

type ValuriseSplashProps = {
  status: ValuriseSplashStatus;
  onComplete: () => void;
};

type Viewport = { width: number; height: number };

const LOGO_VIEWBOX_SIZE = 512;
const LOGO_ART_WIDTH = 476;
const LOGO_ART_HEIGHT = 384;
const initialViewport = { width: 1280, height: 800 };

export function ValuriseSplash({ status, onComplete }: ValuriseSplashProps) {
  const systemReducedMotion = useReducedMotion();
  const [hasHydrated, setHasHydrated] = useState(false);
  const reducedMotion = hasHydrated && Boolean(systemReducedMotion);
  const [viewport, setViewport] = useState<Viewport>(initialViewport);
  const [introComplete, setIntroComplete] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [exitComplete, setExitComplete] = useState(false);
  const completed = useRef(false);

  useEffect(() => {
    setHasHydrated(true);

    const updateViewport = () => {
      const nextViewport = {
        width: Math.max(1, window.innerWidth),
        height: Math.max(1, window.innerHeight),
      };
      setViewport((current) =>
        current.width === nextViewport.width && current.height === nextViewport.height ? current : nextViewport,
      );
    };

    updateViewport();
    window.addEventListener("resize", updateViewport, { passive: true });
    return () => window.removeEventListener("resize", updateViewport);
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

  const coverScale = Math.max(viewport.width / LOGO_VIEWBOX_SIZE, viewport.height / LOGO_VIEWBOX_SIZE);
  const markSize = Math.min(112, Math.max(76, viewport.width * 0.2));
  const markScale = markSize / (LOGO_VIEWBOX_SIZE * coverScale);
  const apertureWidth = (markSize * LOGO_ART_WIDTH) / LOGO_VIEWBOX_SIZE;
  const apertureHeight = (markSize * LOGO_ART_HEIGHT) / LOGO_VIEWBOX_SIZE;
  const revealScale = Math.max(viewport.width / apertureWidth, viewport.height / apertureHeight) * 1.12;
  const revealStyle = {
    "--reveal-scale": revealScale,
  } as CSSProperties;

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

  function handleRevealTransitionEnd(event: TransitionEvent<SVGSVGElement>) {
    if (event.target === event.currentTarget && event.propertyName === "transform" && revealing && status === "ready") {
      setExitComplete(true);
    }
  }

  return (
    <div
      className={`${styles.splash} ${revealing ? styles.revealing : ""} ${exitComplete ? styles.exiting : ""}`}
      onTransitionEnd={handleRootTransitionEnd}
    >
      <svg
        className={styles.revealCurtain}
        data-testid="splash-reveal-mask"
        data-state={revealing ? "revealing" : status}
        data-intro-complete={String(introComplete)}
        viewBox="0 0 512 512"
        preserveAspectRatio="xMidYMid slice"
        style={revealStyle}
        onTransitionEnd={handleRevealTransitionEnd}
        aria-hidden="true"
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
            <g transform={`translate(256 256) scale(${markScale}) translate(-256 -256)`}>
              <image
                href="/valurise-icon.webp"
                width="512"
                height="512"
                filter="url(#valurise-splash-blacken)"
              />
            </g>
          </mask>
        </defs>
        <rect width="512" height="512" fill="#12131a" mask="url(#valurise-splash-mark-mask)" />
      </svg>

      <div className={`${styles.brandContent} ${revealing ? styles.brandLeaving : ""}`}>
        <div
          className={`${styles.mark} ${waiting ? styles.waiting : ""} ${introComplete ? styles.formed : ""}`}
          data-testid="splash-mark"
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
              fill
              sizes="(max-width: 480px) 76px, 112px"
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
