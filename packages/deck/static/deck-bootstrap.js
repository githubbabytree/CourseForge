(function bootstrapCourseForgeDeck() {
  "use strict";
  const configElement = document.getElementById("courseforge-deck-config");
  if (!configElement) throw new Error("CourseForge deck configuration is missing");
  const config = JSON.parse(configElement.textContent || "{}");
  const plugins = typeof RevealNotes === "undefined" ? [] : [RevealNotes];
  const slides = Array.from(document.querySelectorAll(".slides > section"));
  const finalRender = new URLSearchParams(window.location.search).get("courseforge-render") === "final";
  if (finalRender) {
    for (const slide of slides) {
      slide.removeAttribute("data-auto-animate");
      slide.dataset.transition = "none";
    }
  }

  const initialize = Promise.resolve(Reveal.initialize({
    ...config.reveal,
    ...(finalRender ? { controls: false, progress: false, transition: "none", autoAnimate: false } : {}),
    plugins,
  }));
  const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const waitForVisualStability = async () => {
    await initialize;
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await Promise.all(Array.from(document.images, (candidate) => candidate.complete
      ? Promise.resolve()
      : candidate.decode()));
    Reveal.layout();
    await nextPaint();
  };
  const durations = slides.map((slide) => Number(slide.dataset.durationMs || 5000));
  const totalDurationMs = durations.reduce((sum, duration) => sum + duration, 0);
  window.CourseForgeRender = Object.freeze({
    ready: waitForVisualStability(),
    finalRender,
    totalDurationMs,
    async seek(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new TypeError("seek expects non-negative milliseconds");
      if (milliseconds >= totalDurationMs) throw new RangeError("seek exceeds the deck duration");
      await initialize;
      let elapsed = 0;
      let targetIndex = 0;
      for (let index = 0; index < slides.length; index += 1) {
        const duration = durations[index];
        if (milliseconds < elapsed + duration) { targetIndex = index; break; }
        elapsed += duration;
        targetIndex = index;
      }
      Reveal.slide(targetIndex, 0, 0);
      await waitForVisualStability();
      return { slideIndex: targetIndex, localTimeMs: Math.max(0, milliseconds - elapsed) };
    },
    getState() {
      const indices = Reveal.getIndices();
      return { deckId: config.deckId, slideIndex: indices.h, slideId: slides[indices.h]?.dataset.slideId };
    },
  });
})();
