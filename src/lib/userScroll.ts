/**
 * Tell scrolls the reader made (wheel, touch, keys, scrollbar) from scrolls
 * the app made. Only the reader's own scrolls are passed to the other view,
 * so two synchronized views can never chase each other.
 */
export interface UserScrollWatch {
  /** call before a programmatic scroll: its scroll events are not the reader's */
  quiet(): void;
  stop(): void;
}

export function watchUserScroll(el: HTMLElement, onUser: () => void, windowMs = 400): UserScrollWatch {
  let until = 0;
  let down = false;
  const mark = () => {
    until = performance.now() + windowMs;
  };
  const onDown = () => {
    down = true;
    mark();
  };
  const onUp = () => {
    if (!down) return;
    down = false;
    mark();
  };
  const onScroll = () => {
    if (down || performance.now() < until) onUser();
  };
  const opts = { passive: true } as const;
  el.addEventListener("wheel", mark, opts);
  el.addEventListener("touchstart", mark, opts);
  el.addEventListener("touchmove", mark, opts);
  el.addEventListener("keydown", mark);
  el.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerup", onUp);
  el.addEventListener("scroll", onScroll, opts);
  return {
    quiet() {
      until = 0;
      down = false;
    },
    stop() {
      el.removeEventListener("wheel", mark);
      el.removeEventListener("touchstart", mark);
      el.removeEventListener("touchmove", mark);
      el.removeEventListener("keydown", mark);
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      el.removeEventListener("scroll", onScroll);
    },
  };
}
