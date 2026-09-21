export const motionTokens = {
  duration: {
    instant: 0.12,
    fast: 0.18,
    normal: 0.26,
    enter: 0.34,
    slow: 0.42,
  },
  stagger: 0.07,
  ease: {
    enter: [0.22, 1, 0.36, 1] as const,
    exit: [0.4, 0, 1, 1] as const,
    standard: [0.4, 0, 0.2, 1] as const,
  },
} as const;

export const pageMotion = {
  initial: { opacity: 0, y: 6 },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      duration: motionTokens.duration.normal,
      ease: motionTokens.ease.enter,
    },
  },
  exit: {
    opacity: 0,
    y: -4,
    transition: { duration: motionTokens.duration.fast, ease: motionTokens.ease.exit },
  },
};

export const cardMotion = {
  initial: { opacity: 0, y: 12 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: motionTokens.duration.enter, ease: motionTokens.ease.enter },
  },
};
