"use client";

import { animate, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cardMotion, motionTokens, pageMotion } from "@/lib/motion";
import { formatBRL } from "@/lib/finance";

export function AnimatedPage({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? { opacity: 0 } : pageMotion.initial}
      animate={reduced ? { opacity: 1 } : pageMotion.animate}
      exit={reduced ? { opacity: 0 } : pageMotion.exit}
    >
      {children}
    </motion.div>
  );
}

export function StaggerContainer({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial="initial"
      animate="animate"
      variants={{
        initial: {},
        animate: { transition: { staggerChildren: reduced ? 0 : motionTokens.stagger } },
      }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className, layout = false }: { children: ReactNode; className?: string; layout?: boolean }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      layout={layout}
      variants={reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 } } : cardMotion}
    >
      {children}
    </motion.div>
  );
}

export function AnimatedCard({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? { opacity: 0 } : cardMotion.initial}
      animate={reduced ? { opacity: 1 } : cardMotion.animate}
      whileHover={reduced ? undefined : { y: -2, transition: { duration: motionTokens.duration.fast } }}
      transition={{ duration: motionTokens.duration.fast, ease: motionTokens.ease.standard }}
    >
      {children}
    </motion.div>
  );
}

export function AnimatedNumber({ cents, className }: { cents: number; className?: string }) {
  const reduced = useReducedMotion();
  const previous = useRef(cents);
  const [display, setDisplay] = useState(cents);
  useEffect(() => {
    if (reduced) {
      previous.current = cents;
      setDisplay(cents);
      return;
    }
    const controls = animate(previous.current, cents, {
      duration: motionTokens.duration.slow * 2,
      ease: motionTokens.ease.enter,
      onUpdate: (value) => setDisplay(Math.round(value)),
    });
    previous.current = cents;
    return () => controls.stop();
  }, [cents, reduced]);
  return <span className={className}>{formatBRL(display)}</span>;
}

export function AnimatedProgress({ value, className }: { value: number; className?: string }) {
  const reduced = useReducedMotion();
  const percentage = Math.max(0, Math.min(100, value));
  return (
    <motion.span
      className={className}
      initial={{ scaleX: reduced ? 1 : 0 }}
      animate={{ scaleX: 1, width: `${percentage}%` }}
      transition={{ duration: reduced ? 0.01 : motionTokens.duration.slow * 1.5, ease: motionTokens.ease.enter }}
      style={{ transformOrigin: "left center" }}
    />
  );
}
