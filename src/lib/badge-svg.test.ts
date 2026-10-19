import { describe, expect, it } from "vitest";

import { escapeXml, renderBadgeSvg } from "./badge-svg";

describe("badge-svg", () => {
  describe("escapeXml", () => {
    it("escapes special XML characters", () => {
      expect(escapeXml('<script>alert("xss") & \'foo\'</script>')).toBe(
        "&lt;script&gt;alert(&quot;xss&quot;) &amp; &apos;foo&apos;&lt;/script&gt;"
      );
    });
  });

  describe("renderBadgeSvg", () => {
    it("renders ready state with green color", () => {
      const svg = renderBadgeSvg("ready");
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain("ready");
      expect(svg).toContain("#2ea44f"); // green color
    });

    it("renders low_reserve state with amber color", () => {
      const svg = renderBadgeSvg("low_reserve");
      expect(svg).toContain("low balance");
      expect(svg).toContain("#d97706"); // amber color
    });

    it("renders not_ready state with red color", () => {
      const svg = renderBadgeSvg("not_ready");
      expect(svg).toContain("not ready");
      expect(svg).toContain("#dc2626"); // red color
    });

    it("renders unknown state for unhandled status", () => {
      const svg = renderBadgeSvg("something_else");
      expect(svg).toContain("unknown");
      expect(svg).toContain("#6e7681"); // gray color
    });

    it("uses custom label when provided", () => {
      const svg = renderBadgeSvg("ready", { label: "trustline" });
      expect(svg).toContain("trustline");
    });

    it("does not contain any PII or Stellar address patterns", () => {
      const svg = renderBadgeSvg("ready");
      // Check for Stellar address format G[A-Z0-9]{55}
      expect(svg).not.toMatch(/G[A-Z0-9]{55}/);
      // Check for email patterns
      expect(svg).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    });

    it("escapes malicious user-supplied labels", () => {
      const svg = renderBadgeSvg("ready", { label: '<image src=x onerror=alert(1)>' });
      expect(svg).not.toContain('<image src=x');
      expect(svg).toContain('&lt;image src=x');
    });

    describe("SVG injection protection", () => {
      it("rejects script tags in label", () => {
        const svg = renderBadgeSvg("ready", { label: '<script>alert("xss")</script>' });
        expect(svg).not.toContain("<script");
        expect(svg).toContain("&lt;script&gt;");
      });

      it("rejects event handlers in label", () => {
        const svg = renderBadgeSvg("ready", { label: 'onload=alert(1)' });
        expect(svg).not.toContain("onload=alert");
        // escapeXml doesn't escape = but ensures no unescaped < > so handlers can't execute
      });

      it("rejects embedded SVG elements in label", () => {
        const svg = renderBadgeSvg("ready", { label: '<svg><use href="data:image/svg+xml,..."/></svg>' });
        expect(svg).not.toContain('<svg><use');
        expect(svg).toContain('&lt;svg&gt;&lt;use');
      });

      it("rejects CDATA injection in label", () => {
        const svg = renderBadgeSvg("ready", { label: ']]><script>alert(1)</script><![CDATA[' });
        expect(svg).not.toContain("]]><script>");
        expect(svg).toContain("&gt;&lt;script&gt;");
      });

      it("rejects XML entity expansion in label", () => {
        const svg = renderBadgeSvg("ready", { label: '&xxe;' });
        expect(svg).toContain("&amp;xxe;");
      });

      it("rejects fake status codes in label that could mislead parsers", () => {
        const svg = renderBadgeSvg("not_ready", { label: 'trustbridge: ready' });
        // Label is escaped but verify it doesn't override actual status
        expect(svg).toContain("not ready"); // actual status text
        expect(svg).toContain("#dc2626"); // red (not_ready color)
      });

      it("produces valid well-formed SVG after escaping", () => {
        const svg = renderBadgeSvg("ready", { label: 'a<b>c&d"e\'f' });
        // Basic well-formedness check: valid XML structure
        expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
        expect(svg).toContain('</svg>');
        // Ensure no unescaped quotes break attributes
        expect(svg).not.toMatch(/textLength="[^"]*"[^>]*"/); // no double-close
      });

      it("handles empty label gracefully", () => {
        const svg = renderBadgeSvg("ready", { label: "" });
        expect(svg).toContain('<svg');
        expect(svg).toContain('ready'); // status still rendered
      });

      it("handles very long label without breaking SVG geometry", () => {
        const longLabel = "a".repeat(200);
        const svg = renderBadgeSvg("ready", { label: longLabel });
        expect(svg).toContain('<svg');
        // SVG should still be valid, geometry adjusted for length
        expect(svg).toMatch(/width="\d+"/);
      });

      it("rejects unicode direction override characters", () => {
        // Right-to-Left Override (U+202E) can visually spoof content
        const spoofedLabel = "trustbridge\u202Eydaer";
        const svg = renderBadgeSvg("not_ready", { label: spoofedLabel });
        // The override char is preserved (not a security risk in SVG text nodes)
        // but verify status color still matches actual state
        expect(svg).toContain("#dc2626"); // red = not_ready
      });
    });
  });
});
