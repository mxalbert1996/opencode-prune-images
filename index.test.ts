import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import plugin, {
  pruneImages,
  persistToRollingCache,
  MAX_IMAGES_IN_CONTEXT,
  DEFAULT_MAX_IMAGES_IN_CONTEXT,
  MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_BYTES,
  setCacheDir,
  getCacheDir,
  setMaxImages,
  getMaxImages,
  setMaxImageBytes,
  getMaxImageBytes,
  parseByteString,
  enforceCacheCap,
  resolveCacheDirFromEnv,
} from "./index";

const TEST_CACHE_DIR = path.join(os.tmpdir(), "opencode-prune-images-test-" + Date.now());

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeImageSession(nImages: number) {
  return Array.from({ length: nImages }, (_, i) => ({
    role: "user",
    content: `capture ${i}`,
    parts: [
      { type: "text", text: `capture ${i}` },
      { type: "file", mime: "image/png", name: `screenshot-${i}.png`, uri: TINY_PNG },
    ],
  }));
}

function countRawImages(messages: unknown[]): number {
  let n = 0;
  for (const m of messages) {
    const parts = (m as { parts?: unknown[] })?.parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      const part = p as { type?: string; uri?: unknown; data?: unknown };
      if (part.type === "file" && typeof part.uri === "string" && part.uri.startsWith("data:image/")) n++;
      if (part.type === "image" && part.data !== undefined) n++;
    }
  }
  return n;
}

beforeEach(() => {
  delete process.env.OPENCODE_MAX_IMAGES;
  delete process.env.OPENCODE_MAX_IMAGE_BYTES;
  setCacheDir(TEST_CACHE_DIR);
  setMaxImages(DEFAULT_MAX_IMAGES_IN_CONTEXT);
  setMaxImageBytes(DEFAULT_MAX_IMAGE_BYTES);
});

afterEach(() => {
  try {
    if (fs.existsSync(TEST_CACHE_DIR)) {
      fs.rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup error
  }
});

test("exports standard defaults and getters/setters", () => {
  expect(DEFAULT_MAX_IMAGES_IN_CONTEXT).toBe(7);
  expect(MAX_IMAGES_IN_CONTEXT).toBe(7);
  expect(getMaxImages()).toBe(7);

  expect(DEFAULT_MAX_IMAGE_BYTES).toBe(16 * 1024 * 1024);
  expect(MAX_IMAGE_BYTES).toBe(16 * 1024 * 1024);
  expect(getMaxImageBytes()).toBe(16 * 1024 * 1024);

  setMaxImages(4);
  expect(getMaxImages()).toBe(4);

  // Negative or invalid values should not overwrite
  setMaxImages(-1);
  expect(getMaxImages()).toBe(4);
  setMaxImages(Number.NaN);
  expect(getMaxImages()).toBe(4);

  setMaxImages(7);
  expect(getMaxImages()).toBe(7);

  setMaxImageBytes(3 * 1024 * 1024);
  expect(getMaxImageBytes()).toBe(3 * 1024 * 1024);
  setMaxImageBytes(-100);
  expect(getMaxImageBytes()).toBe(3 * 1024 * 1024);
  setMaxImageBytes(Number.NaN);
  expect(getMaxImageBytes()).toBe(3 * 1024 * 1024);
  setMaxImageBytes(4 * 1024 * 1024);
  expect(getMaxImageBytes()).toBe(4 * 1024 * 1024);

  expect(parseByteString("4MB")).toBe(4 * 1024 * 1024);
  expect(parseByteString("8MB")).toBe(8 * 1024 * 1024);
  expect(parseByteString("64kb")).toBe(64 * 1024);
  expect(parseByteString("1048576")).toBe(1048576);

  expect(getCacheDir()).toBe(TEST_CACHE_DIR);
});

test("no-op when total images is less than or equal to maxImages", () => {
  const messages = [
    {
      role: "user",
      content: "Please check this image",
      parts: [
        { type: "text", text: "Please check this image" },
        { type: "image", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" } }
      ]
    }
  ];

  const pruned = pruneImages({ messages }, 5);
  expect(pruned).toBe(0);
  expect(messages[0].parts[1].type).toBe("image");
});

test("prunes oldest images when exceeding maxImages", () => {
  const makeImgPart = (id: number) => ({
    type: "image",
    filename: `screenshot-${id}.png`,
    data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  });

  const messages = [
    {
      role: "user",
      content: "Look at these steps",
      parts: [
        { type: "text", text: "Step 1" },
        makeImgPart(1),
        { type: "text", text: "Step 2" },
        makeImgPart(2),
        { type: "text", text: "Step 3" },
        makeImgPart(3),
      ]
    },
    {
      role: "assistant",
      content: "I see steps 1 to 3."
    },
    {
      role: "user",
      content: "Here are more steps",
      parts: [
        { type: "text", text: "Step 4" },
        makeImgPart(4),
        { type: "text", text: "Step 5" },
        makeImgPart(5),
      ]
    }
  ];

  // Total 5 images. Cap at 3 -> prune 2 oldest (Step 1 and Step 2)
  const pruned = pruneImages({ messages }, 3);
  expect(pruned).toBe(2);

  // First 2 images should be converted to text cards
  expect(messages[0].parts[1].type).toBe("text");
  expect((messages[0].parts[1] as { text?: string }).text).toContain("[Pruned Image:");
  expect((messages[0].parts[1] as { text?: string }).text).toContain("screenshot-1.png");

  expect(messages[0].parts[3].type).toBe("text");
  expect((messages[0].parts[3] as { text?: string }).text).toContain("[Pruned Image:");
  expect((messages[0].parts[3] as { text?: string }).text).toContain("screenshot-2.png");

  // Third, fourth, fifth images remain untouched
  expect(messages[0].parts[5].type).toBe("image");
  expect(messages[2].parts[1].type).toBe("image");
  expect(messages[2].parts[3].type).toBe("image");
});

test("persists ephemeral /tmp/ files into rolling cache directory", () => {
  fs.mkdirSync(TEST_CACHE_DIR, { recursive: true });

  const tmpImgPath = path.join(os.tmpdir(), `test-capture-${Date.now()}.png`);
  fs.writeFileSync(tmpImgPath, Buffer.from("dummy-png-data"));

  const cached = persistToRollingCache(undefined, tmpImgPath, "image/png");
  expect(cached).toBeDefined();
  expect(cached).not.toBe(tmpImgPath);
  expect(cached?.startsWith(TEST_CACHE_DIR)).toBe(true);
  expect(fs.existsSync(cached!)).toBe(true);

  // Clean up source tmp
  fs.unlinkSync(tmpImgPath);
});

test("handles file:// URLs correctly", () => {
  fs.mkdirSync(TEST_CACHE_DIR, { recursive: true });

  const tmpImgPath = path.join(os.tmpdir(), `test-fileurl-${Date.now()}.png`);
  fs.writeFileSync(tmpImgPath, Buffer.from("dummy-png-data"));

  const fileUrl = `file://${tmpImgPath}`;
  const cached = persistToRollingCache(undefined, fileUrl, "image/png");

  expect(cached).toBeDefined();
  expect(cached?.startsWith(TEST_CACHE_DIR)).toBe(true);
  expect(fs.existsSync(cached!)).toBe(true);

  fs.unlinkSync(tmpImgPath);
});

test("enforces cache cap with FIFO deletion", () => {
  fs.mkdirSync(TEST_CACHE_DIR, { recursive: true });

  // Create 5 files with distinct times
  for (let i = 0; i < 5; i++) {
    const fPath = path.join(TEST_CACHE_DIR, `img_00${i}.png`);
    fs.writeFileSync(fPath, `data-${i}`);
    const time = new Date(Date.now() - (5 - i) * 1000);
    fs.utimesSync(fPath, time, time);
  }

  expect(fs.readdirSync(TEST_CACHE_DIR).length).toBe(5);

  // Cap at 3
  enforceCacheCap(3);

  const remaining = fs.readdirSync(TEST_CACHE_DIR);
  expect(remaining.length).toBe(3);
  expect(remaining).not.toContain("img_000.png");
  expect(remaining).not.toContain("img_001.png");
  expect(remaining).toContain("img_004.png");
});

test("never mutates tool-call input arguments that hold image-shaped data", () => {
  const input = { image: { url: TINY_PNG, mime: "image/png" }, result: TINY_PNG };
  const messages = [
    {
      role: "assistant",
      content: [{ type: "tool-call", id: "c1", name: "image_tool", input }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "image_tool",
          result: { type: "content", value: [{ type: "text", text: "processed" }] },
        },
      ],
    },
  ];

  const pruned = pruneImages({ messages }, 0, 0);

  expect(pruned).toBe(0);
  expect((messages[0] as any).content[0].input).toEqual(input);
  expect((messages[1] as any).content[0].result.value).toEqual([{ type: "text", text: "processed" }]);
});

test("handles gemini-part inlineData format correctly", () => {
  const messages = [
    {
      role: "user",
      parts: [
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="
          }
        },
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="
          }
        }
      ]
    }
  ];

  const pruned = pruneImages({ messages }, 1);
  expect(pruned).toBe(1);
  // Gemini part converted to text
  expect((messages[0].parts[0] as { text?: string }).text).toContain("[Pruned Image:");
  expect((messages[0].parts[1] as { inlineData?: unknown }).inlineData).toBeDefined();
});

test("handles empty or malformed inputs without throwing", () => {
  expect(pruneImages(null)).toBe(0);
  expect(pruneImages(undefined)).toBe(0);
  expect(pruneImages({})).toBe(0);
  expect(pruneImages({ messages: [] })).toBe(0);
  expect(pruneImages({ messages: "invalid" as unknown as unknown[] })).toBe(0);
  expect(pruneImages([{ broken: true }])).toBe(0);
});

test("dual-budget cap: prunes older images exceeding maxBytes even when count is under maxImages", () => {
  // Create 4 images, each approx 2.5 MB of payload (total 10 MB).
  // With maxBytes = 6 MB and maxImages = 7:
  // Count is 4 <= 7, but byte total is 10 MB > 6 MB!
  // It should retain the 2 newest (2 * 2.5MB = 5MB <= 6MB) and prune the older 2!
  const chunk2_5MB = "A".repeat(2_500_000);
  const makeLargeImg = (id: number) => ({
    type: "image",
    filename: `big-render-${id}.png`,
    data: `data:image/png;base64,${chunk2_5MB}`,
  });

  const messages = [
    {
      role: "user",
      content: "Analyze visual rendering performance",
      parts: [
        { type: "text", text: "Frame 1" },
        makeLargeImg(1),
        { type: "text", text: "Frame 2" },
        makeLargeImg(2),
      ],
    },
    {
      role: "assistant",
      content: "Observed first two frames.",
    },
    {
      role: "user",
      content: "Here are frames 3 and 4",
      parts: [
        { type: "text", text: "Frame 3" },
        makeLargeImg(3),
        { type: "text", text: "Frame 4" },
        makeLargeImg(4),
      ],
    },
  ];

  // maxImages = 7 (allows all 4 by count), maxBytes = 6 MB
  const maxBytes = 6 * 1024 * 1024;
  const pruned = pruneImages({ messages }, 7, maxBytes);

  expect(pruned).toBe(2);

  // Frames 1 and 2 (older) pruned to 3-point cards
  expect(messages[0].parts[1].type).toBe("text");
  expect((messages[0].parts[1] as { text?: string }).text).toContain("[Pruned Image:");
  expect((messages[0].parts[1] as { text?: string }).text).toContain("big-render-1.png");

  expect(messages[0].parts[3].type).toBe("text");
  expect((messages[0].parts[3] as { text?: string }).text).toContain("[Pruned Image:");
  expect((messages[0].parts[3] as { text?: string }).text).toContain("big-render-2.png");

  // Frames 3 and 4 (newest) kept intact
  expect(messages[2].parts[1].type).toBe("image");
  expect(messages[2].parts[3].type).toBe("image");
});

test("enforces 16MB (16,777,216 bytes) wire base64 default budget", () => {
  // 3 images of 7MB wire base64 length each (total ~21MB)
  // With DEFAULT_MAX_IMAGE_BYTES (16MB) and maxImages (7):
  // Should keep 2 newest (2 * 7MB = 14MB <= 16MB) and prune oldest 1 (7MB)
  const chunk7MB = "B".repeat(7_000_000);
  const makeWireImg = (id: number) => ({
    type: "image",
    filename: `wire-frame-${id}.png`,
    data: `data:image/png;base64,${chunk7MB}`,
  });

  const messages = [
    {
      role: "user",
      content: "Inspect wire frames",
      parts: [
        { type: "text", text: "Wire 1" },
        makeWireImg(1),
        { type: "text", text: "Wire 2" },
        makeWireImg(2),
        { type: "text", text: "Wire 3" },
        makeWireImg(3),
      ],
    },
  ];

  // Run with default budget (maxImages = 7, maxBytes = 16MB)
  const pruned = pruneImages({ messages });
  expect(pruned).toBe(1);

  // Wire 1 (oldest) pruned to 3-point card
  expect(messages[0].parts[1].type).toBe("text");
  expect((messages[0].parts[1] as { text?: string }).text).toContain("[Pruned Image:");
  expect((messages[0].parts[1] as { text?: string }).text).toContain("wire-frame-1.png");

  // Wire 2 and Wire 3 remain intact
  expect(messages[0].parts[3].type).toBe("image");
  expect(messages[0].parts[5].type).toBe("image");
});

test("compaction budgets of 0 strip 100% of images to 3-point cards", () => {
  const messages = [
    {
      role: "user",
      content: "Please check design and alignment",
      parts: [
        { type: "text", text: "Initial mockup" },
        {
          type: "image",
          filename: "mockup-desktop.png",
          data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
    },
    {
      role: "assistant",
      content: "I reviewed mockup-desktop.png and verified 16px margins.",
    },
    {
      role: "user",
      content: "Here is mobile view",
      parts: [
        { type: "text", text: "Mobile mockup" },
        {
          type: "image",
          filename: "mockup-mobile.png",
          data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
    },
  ];

  const pruned = pruneImages({ messages }, 0, 0);
  expect(pruned).toBe(2);

  // First image -> 3-point card
  expect(messages[0].parts[1].type).toBe("text");
  const card1 = (messages[0].parts[1] as { text?: string }).text || "";
  expect(card1).toContain("[Pruned Image:");
  expect(card1).toContain("mockup-desktop.png");
  expect(card1).not.toContain("data:image/");

  // Second image -> 3-point card
  expect(messages[2].parts[1].type).toBe("text");
  const card2 = (messages[2].parts[1] as { text?: string }).text || "";
  expect(card2).toContain("[Pruned Image:");
  expect(card2).toContain("mockup-mobile.png");
  expect(card2).not.toContain("data:image/");

  // Zero raw base64 or image parts remain in messages
  for (const msg of messages) {
    if (Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        expect((part as { type?: string }).type).not.toBe("image");
        expect((part as { data?: string }).data).toBeUndefined();
      }
    }
  }
});

test("compaction-looking user text does not override the configured budgets", () => {
  const messages = [
    {
      role: "user",
      content: "Initial visual check",
      parts: [
        {
          type: "image",
          filename: "view.png",
          data: TINY_PNG,
        },
      ],
    },
    {
      role: "assistant",
      content: "Observed view.",
    },
    {
      role: "user",
      content: "summarize conversation history",
    },
  ];

  const pruned = pruneImages({ messages }, 7, 16 * 1024 * 1024);
  expect(pruned).toBe(0);
  expect(messages[0].parts[0].type).toBe("image");
});

test("causal chain context extraction across multi-step tool loops", () => {
  // Multi-step loop:
  // user -> tool(bash) -> tool(read image) -> tool(grep) -> assistant("Found 12px alignment issue")
  const messages = [
    {
      role: "user",
      content: "Check UI alignment on the checkout button",
    },
    {
      role: "tool",
      content: [
        {
          tool: "bash",
          result: "git status: clean",
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          tool: "read_screenshot",
          result: "Image read successfully.", // boilerplate!
        },
      ],
      parts: [
        {
          type: "image",
          filename: "checkout-button.png",
          data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          tool: "grep",
          result: "padding: 8px;",
        },
      ],
    },
    {
      role: "assistant",
      content: "Found 12px alignment issue where button padding is overflowing container bounds.",
    },
  ];

  // Cap at 0 images so it prunes
  const pruned = pruneImages({ messages }, 0);
  expect(pruned).toBe(1);

  const prunedPart = messages[2].parts[0] as { type: string; text: string };
  expect(prunedPart.type).toBe("text");
  expect(prunedPart.text).toContain("[Pruned Image:");
  // Intent should crawl backwards skipping intermediate tools to reach user prompt
  expect(prunedPart.text).toContain("Check UI alignment on the checkout button");
  // Observed should skip "Image read successfully." boilerplate and forward crawl to assistant synthesis!
  expect(prunedPart.text).toContain("Found 12px alignment issue where button padding is overflowing");
});

test("defensively avoids double-wrapping already pruned image cards", () => {
  const messages = [
    {
      role: "user",
      content: "Test already pruned",
      parts: [
        {
          type: "text",
          text: "[Pruned Image: /some/path/img.png]\n• What's visible: Something\n• Why it was captured: Prior task\n• Recall: Read from path",
        },
        {
          type: "image",
          filename: "new-capture.png",
          data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
    },
  ];

  // When prune is run with maxImages = 1, new-capture is kept, pruned card is not touched
  const pruned = pruneImages({ messages }, 1);
  expect(pruned).toBe(0);
  expect((messages[0].parts[0] as { text: string }).text).not.toContain("[Pruned Image: [Pruned Image:");
});

test("setup registers the v2 context and compaction session hooks", async () => {
  expect(plugin.id).toBe("opencode.prune-images");
  expect(typeof plugin.setup).toBe("function");
  expect("server" in plugin).toBe(false);

  const handlers: Record<string, (event: unknown) => unknown> = {};
  const registeredNames: string[] = [];
  const mockCtx = {
    session: {
      hook: async (name: string, cb: (event: unknown) => unknown) => {
        registeredNames.push(name);
        handlers[name] = cb;
      },
    },
  };

  await plugin.setup(mockCtx);
  expect(registeredNames).toEqual(["context", "compaction"]);

  const normal = { messages: makeImageSession(35) };
  await handlers.context?.(normal);
  expect(countRawImages(normal.messages)).toBe(7);

  const compaction = { messages: makeImageSession(35) };
  await handlers.compaction?.(compaction);
  expect(countRawImages(compaction.messages)).toBe(0);
});

test("prunes tool-result media and keeps the tool call intact", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "check screenshots" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "reading" },
        { type: "tool-call", id: "c1", name: "read", input: { path: "a.png" } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Image read successfully" },
              { type: "file", uri: TINY_PNG, mime: "image/png", name: "shot-1.png" },
              { type: "file", uri: TINY_PNG, mime: "image/png", name: "shot-2.png" },
              { type: "file", uri: TINY_PNG, mime: "image/png", name: "shot-3.png" },
            ],
          },
        },
      ],
    },
  ];

  const pruned = pruneImages({ messages }, 1, 16 * 1024 * 1024);
  expect(pruned).toBe(2);

  const toolResult = (messages[2] as any).content[0];
  expect(toolResult.type).toBe("tool-result");
  expect(toolResult.id).toBe("c1");
  expect(toolResult.name).toBe("read");

  const value = toolResult.result.value;
  expect(value[0]).toEqual({ type: "text", text: "Image read successfully" });
  expect(value[1].type).toBe("text");
  expect(String(value[1].text)).toContain("[Pruned Image:");
  expect(value[2].type).toBe("text");
  expect(String(value[2].text)).toContain("[Pruned Image:");

  expect(value[3].type).toBe("file");
  expect(value[3].name).toBe("shot-3.png");
  expect(String(value[3].uri).startsWith("data:image/")).toBe(true);

  expect((messages[1] as any).content[1].input).toEqual({ path: "a.png" });
});

test("cache dir honours XDG_CACHE_HOME and falls back to ~/.cache", () => {
  const fallback = path.join(os.homedir(), ".cache", "opencode", "recent-images");

  expect(resolveCacheDirFromEnv({ XDG_CACHE_HOME: "/tmp/xdg-cache" })).toBe(
    path.join("/tmp/xdg-cache", "opencode", "recent-images")
  );
  expect(resolveCacheDirFromEnv({ XDG_CACHE_HOME: "   " })).toBe(fallback);
  expect(resolveCacheDirFromEnv({})).toBe(fallback);
});

test("plugin options set the budgets when no env var is present", async () => {
  const handlers: Record<string, (event: unknown) => unknown> = {};
  await plugin.setup({
    session: {
      hook: async (name: string, cb: (event: unknown) => unknown) => {
        handlers[name] = cb;
      },
    },
    options: { maxImages: 3, maxImageBytes: "1MB" },
  });

  expect(getMaxImages()).toBe(3);
  expect(getMaxImageBytes()).toBe(1024 * 1024);

  const event = { messages: makeImageSession(5) };
  await handlers.context?.(event);
  expect(countRawImages(event.messages)).toBe(3);
});

test("env vars take precedence over plugin options", async () => {
  process.env.OPENCODE_MAX_IMAGES = "5";
  process.env.OPENCODE_MAX_IMAGE_BYTES = "2MB";
  try {
    await plugin.setup({
      session: { hook: async () => {} },
      options: { maxImages: 2, maxImageBytes: "1MB" },
    });

    expect(getMaxImages()).toBe(5);
    expect(getMaxImageBytes()).toBe(2 * 1024 * 1024);
  } finally {
    delete process.env.OPENCODE_MAX_IMAGES;
    delete process.env.OPENCODE_MAX_IMAGE_BYTES;
  }
});

test("plugin options can override the cache directory", async () => {
  const dir = path.join(os.tmpdir(), "prune-images-options-cache");
  await plugin.setup({
    session: { hook: async () => {} },
    options: { cacheDir: dir },
  });

  expect(getCacheDir()).toBe(path.resolve(dir));
});

test("invalid plugin options are rejected without disturbing the defaults", async () => {
  await plugin.setup({
    session: { hook: async () => {} },
    options: { maxImages: "not-a-number", maxImageBytes: -5 },
  });

  expect(getMaxImages()).toBe(DEFAULT_MAX_IMAGES_IN_CONTEXT);
  expect(getMaxImageBytes()).toBe(DEFAULT_MAX_IMAGE_BYTES);
});

async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = original;
  }
}

test("setup reports a host that exposes no session hooks", async () => {
  const { errors } = await captureErrors(() => plugin.setup({}));
  expect(errors.some((e) => e.includes("ctx.session.hook is unavailable"))).toBe(true);
});

test("setup keeps a working hook when the other registration fails", async () => {
  const registered: string[] = [];
  const { errors } = await captureErrors(() =>
    plugin.setup({
      session: {
        hook: async (name: string) => {
          if (name === "context") throw new Error("host refused");
          registered.push(name);
        },
      },
    })
  );

  expect(registered).toEqual(["compaction"]);
  expect(errors.some((e) => e.includes('failed to register the "context"'))).toBe(true);
  expect(errors.some((e) => e.includes("no session hooks registered"))).toBe(false);
});

test("setup reports when no session hook registers at all", async () => {
  const { errors } = await captureErrors(() =>
    plugin.setup({
      session: {
        hook: async () => {
          throw new Error("nope");
        },
      },
    })
  );

  expect(errors.some((e) => e.includes("no session hooks registered"))).toBe(true);
});

test("setup supersedes setters called before it", async () => {
  setMaxImages(3);
  await plugin.setup({ session: { hook: async () => {} }, options: { maxImages: 5 } });
  expect(getMaxImages()).toBe(5);
});

test("setters remain effective after setup", async () => {
  await plugin.setup({ session: { hook: async () => {} }, options: { maxImages: 5 } });
  setMaxImages(2);
  setMaxImageBytes(1024);

  expect(getMaxImages()).toBe(2);
  expect(getMaxImageBytes()).toBe(1024);
});

test("setters reject non-finite values", () => {
  setMaxImages(Infinity);
  setMaxImageBytes(Number.POSITIVE_INFINITY);

  expect(getMaxImages()).toBe(DEFAULT_MAX_IMAGES_IN_CONTEXT);
  expect(getMaxImageBytes()).toBe(DEFAULT_MAX_IMAGE_BYTES);
});

test("prunes an image with no retrievable payload to an explicitly uncached card", () => {
  const messages = [
    {
      role: "user",
      content: "x",
      parts: [
        { type: "text", text: "x" },
        { type: "file", mime: "image/png", name: "gone.png" },
      ],
    },
  ];

  const pruned = pruneImages({ messages }, 0, 0);

  expect(pruned).toBe(1);
  const card = (messages[0].parts[1] as { text?: string }).text ?? "";
  expect(card).toContain("[Pruned Image: not cached]");
  expect(card).toContain("cannot be re-read");
  expect(card).not.toContain("~/.cache");
});

test("server.ts shim exposes the same plugin for directory-form loading", async () => {
  const shim = await import("./server");

  expect(shim.default).toBe(plugin);
  expect(typeof shim.default.setup).toBe("function");
});

test("DEFAULT_CACHE_DIR follows XDG_CACHE_HOME at import time", () => {
  const indexPath = path.join(import.meta.dir, "index.ts");
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `const m = await import(${JSON.stringify(indexPath)}); console.log(m.DEFAULT_CACHE_DIR);`,
    ],
    env: { ...process.env, XDG_CACHE_HOME: "/tmp/prune-xdg-import" },
  });

  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString().trim()).toBe(
    path.join("/tmp/prune-xdg-import", "opencode", "recent-images")
  );
});

test("setup supersedes setters even without an options object", async () => {
  setMaxImages(3);
  await plugin.setup({ session: { hook: async () => {} } });

  expect(getMaxImages()).toBe(DEFAULT_MAX_IMAGES_IN_CONTEXT);
});

test("prunes a top-level user file attachment", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "file", uri: TINY_PNG, mime: "image/png", name: "pasted.png" },
      ],
    },
  ];

  const pruned = pruneImages({ messages }, 0, 0);

  expect(pruned).toBe(1);
  expect((messages[0] as any).content[1].type).toBe("text");
  expect(String((messages[0] as any).content[1].text)).toContain("[Pruned Image:");
});

test("the compaction hook strips tool-result media", async () => {
  const handlers: Record<string, (event: unknown) => unknown> = {};
  await plugin.setup({
    session: {
      hook: async (name: string, cb: (event: unknown) => unknown) => {
        handlers[name] = cb;
      },
    },
  });

  const messages = [
    { role: "user", content: [{ type: "text", text: "check" }] },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "file", uri: TINY_PNG, mime: "image/png", name: "shot-1.png" },
              { type: "file", uri: TINY_PNG, mime: "image/png", name: "shot-2.png" },
            ],
          },
        },
      ],
    },
  ];

  await handlers.compaction?.({ messages });

  const value = (messages[1] as any).content[0].result.value;
  expect(value.every((v: any) => v.type === "text")).toBe(true);
  expect(value.every((v: any) => String(v.text).includes("[Pruned Image:"))).toBe(true);
});

test("does not report a recall path when the cache write fails", () => {
  const blocker = path.join(os.tmpdir(), `prune-blocker-${Date.now()}`);
  fs.writeFileSync(blocker, "not a directory");
  setCacheDir(path.join(blocker, "cache"));

  try {
    expect(persistToRollingCache(TINY_PNG, undefined, "image/png")).toBeUndefined();

    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "x" },
          { type: "file", uri: TINY_PNG, mime: "image/png", name: "p.png" },
        ],
      },
    ];

    expect(pruneImages({ messages }, 0, 0)).toBe(1);
    const card = String((messages[0] as any).content[1].text);
    expect(card).toContain("[Pruned Image: not cached]");
    expect(card).not.toContain(blocker);
  } finally {
    fs.rmSync(blocker, { force: true });
  }
});
