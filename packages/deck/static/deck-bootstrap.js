(function bootstrapCourseForgeDeck() {
  "use strict";
  const configElement = document.getElementById("courseforge-deck-config");
  if (!configElement) throw new Error("CourseForge deck configuration is missing");
  const config = JSON.parse(configElement.textContent || "{}");
  const plugins = typeof RevealNotes === "undefined" ? [] : [RevealNotes];
  Reveal.initialize({ ...config.reveal, plugins });

  const slides = Array.from(document.querySelectorAll(".slides > section"));
  window.CourseForgeRender = Object.freeze({
    ready: Reveal.isReady() ? Promise.resolve() : new Promise((resolve) => Reveal.on("ready", resolve)),
    seek(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new TypeError("seek expects non-negative milliseconds");
      let elapsed = 0;
      let targetIndex = 0;
      for (let index = 0; index < slides.length; index += 1) {
        const duration = Number(slides[index].dataset.durationMs || 5000);
        if (milliseconds < elapsed + duration) { targetIndex = index; break; }
        elapsed += duration;
        targetIndex = index;
      }
      Reveal.slide(targetIndex, 0, 0);
      return { slideIndex: targetIndex, localTimeMs: Math.max(0, milliseconds - elapsed) };
    },
    getState() {
      const indices = Reveal.getIndices();
      return { deckId: config.deckId, slideIndex: indices.h, slideId: slides[indices.h]?.dataset.slideId };
    },
  });
})();
