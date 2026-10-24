import { request } from "node:http";
import type { Page } from "playwright";
import type { Step } from "./browser_spec";
function localHttp(origin: string, step: Step): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(origin);
    const req = request(
      { hostname: u.hostname, port: u.port, path: step.path, method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (b) => {
          if (body.length < 1000000) body += b;
        });
        res.on("end", () =>
          res.statusCode === step.status &&
          (!step.contains || body.includes(step.contains))
            ? resolve()
            : reject(
                new Error(
                  `HTTP ${step.path}: expected ${step.status}, observed ${res.statusCode}`,
                ),
              ),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("HTTP timeout")));
    req.end();
  });
}
export async function executeStep(
  page: Page,
  step: Step,
  snapshots: Map<string, string[]>,
  errors: string[],
  origin: string,
): Promise<void> {
  const locator = step.selector ? page.locator(step.selector) : null;
  switch (step.type) {
    case "viewport":
      await page.setViewportSize({ width: step.width!, height: step.height! });
      break;
    case "click":
      await locator!.click();
      break;
    case "press":
      await page.keyboard.press(step.key!);
      break;
    case "reload":
      await page.reload({ waitUntil: "networkidle" });
      break;
    case "visible":
      if (!(await locator!.isVisible()))
        throw new Error(`Not visible: ${step.selector}`);
      break;
    case "count": {
      const n = await locator!.count();
      if (n !== step.equals)
        throw new Error(`Expected ${step.equals} elements, observed ${n}`);
      break;
    }
    case "text": {
      const text = await locator!.innerText();
      if (
        step.equals !== undefined
          ? text !== step.equals
          : !text.includes(step.contains!)
      )
        throw new Error(`Text assertion failed for ${step.selector}`);
      break;
    }
    case "noOverflow":
      if (
        await page.evaluate<boolean>(
          "document.documentElement.scrollWidth > window.innerWidth",
        )
      )
        throw new Error("Horizontal overflow observed");
      break;
    case "within": {
      const outer = await page.locator(step.container!).boundingBox();
      const rects = await locator!.evaluateAll((es) =>
        es.map((e) => {
          const r = e.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      );
      if (
        !outer ||
        !rects.length ||
        rects.some(
          (r) =>
            r.width <= 0 ||
            r.height <= 0 ||
            r.x < outer.x - 1 ||
            r.y < outer.y - 1 ||
            r.x + r.width > outer.x + outer.width + 1 ||
            r.y + r.height > outer.y + outer.height + 1,
        )
      )
        throw new Error(`Elements extend outside ${step.container}`);
      break;
    }
    case "snapshot":
      snapshots.set(step.name!, await locator!.allTextContents());
      if (!snapshots.get(step.name!)!.length)
        throw new Error("Snapshot selector matched no elements");
      break;
    case "sameSnapshot":
    case "differentSnapshot": {
      const before = snapshots.get(step.name!),
        current = await locator!.allTextContents();
      if (
        !before ||
        !current.length ||
        (JSON.stringify(before) === JSON.stringify(current)) !==
          (step.type === "sameSnapshot")
      )
        throw new Error(`Snapshot assertion failed: ${step.name}`);
      break;
    }
    case "noConsoleErrors":
      if (errors.length) throw new Error(errors.join("\n").slice(0, 4000));
      break;
    case "http":
      await localHttp(origin, step);
      break;
    case "drag": {
      const r = await locator!.boundingBox();
      if (!r) throw new Error("Swipe target has no bounds");
      const x = r.x + r.width / 2,
        y = r.y + r.height / 2,
        dx =
          step.direction === "left"
            ? -r.width * 0.3
            : step.direction === "right"
              ? r.width * 0.3
              : 0,
        dy =
          step.direction === "up"
            ? -r.height * 0.3
            : step.direction === "down"
              ? r.height * 0.3
              : 0;
      await page.mouse.move(x - dx / 2, y - dy / 2);
      await page.mouse.down();
      await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 8 });
      await page.mouse.up();
      break;
    }
  }
}
