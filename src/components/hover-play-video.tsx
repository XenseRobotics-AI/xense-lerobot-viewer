"use client";

import React, { useEffect, useRef, useState } from "react";

import { useDocumentVisible } from "@/hooks/use-document-visible";

type HoverPlayVideoProps = {
  src: string;
  className?: string;
  /** Seconds of preview to play before pausing back at the first frame. */
  maxPreviewSeconds?: number;
};

/**
 * A thumbnail `<video>` that:
 *  - lazy-loads — the `src` (and `preload="metadata"`) is only attached once the
 *    element scrolls near the viewport, so a grid of N cards no longer fires N
 *    metadata requests up front (browsers cap ~6/host, so 81 cards used to queue
 *    into a long stall); and
 *  - plays on hover — it wires mouseenter/leave on its closest `[data-hover-card]`
 *    ancestor (the card `<Link>`/`<button>`), so hovering anywhere on the card
 *    plays even though the video sits behind the overlay/content layers.
 *
 * Shared by the dataset landing (category cards) and the task grid so the
 * hover-play + lazy-load behaviour lives in one place.
 */
export default function HoverPlayVideo({
  src,
  className = "",
  maxPreviewSeconds = 15,
}: HoverPlayVideoProps) {
  const visible = useDocumentVisible();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hoveredRef = useRef(false);
  // Detach previews that leave the viewport so slow storage isn't busy serving
  // cards the operator has already scrolled past.
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!visible) {
      hoveredRef.current = false;
      videoRef.current?.pause();
    }
  }, [visible]);

  // Lazy-load when the card scrolls near the viewport.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setActive(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        setActive(entries.some((e) => e.isIntersecting));
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!active) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    } else if (hoveredRef.current) {
      void el.play().catch(() => undefined);
    }
  }, [active]);

  // Hover-to-play, wired to the enclosing card element.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const card = el.closest("[data-hover-card]") ?? el.parentElement;
    if (!card) return;
    const onEnter = () => {
      hoveredRef.current = true;
      setActive(true);
      void el.play().catch(() => undefined);
    };
    const onLeave = () => {
      hoveredRef.current = false;
      el.pause();
      el.currentTime = 0;
    };
    card.addEventListener("mouseenter", onEnter);
    card.addEventListener("mouseleave", onLeave);
    return () => {
      card.removeEventListener("mouseenter", onEnter);
      card.removeEventListener("mouseleave", onLeave);
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, []);

  return (
    <video
      ref={videoRef}
      src={active ? src : undefined}
      className={className}
      loop
      muted
      playsInline
      preload={active ? "metadata" : "none"}
      onTimeUpdate={(e) => {
        const vid = e.currentTarget;
        if (vid.currentTime >= maxPreviewSeconds) {
          vid.pause();
          vid.currentTime = 0;
        }
      }}
    />
  );
}
