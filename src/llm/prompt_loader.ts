import fs from "node:fs";
import path from "node:path";

export class PromptLoader {
  private readonly baseDir: string;
  private readonly lang: string;
  private readonly variant: string;
  private readonly cache = new Map<string, string>();

  constructor(
    lang: "en" | "tr",
    variant: string = "default",
    baseDir: string = path.join(process.cwd(), "prompts")
  ) {
    this.lang = lang;
    this.variant = variant;
    this.baseDir = baseDir;
  }

  loadTemplate(name: string): string {
    const key = `${this.lang}/${this.variant}/${name}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const variantPath = path.join(this.baseDir, this.lang, this.variant, `${name}.txt`);
    const defaultPath = path.join(this.baseDir, this.lang, "default", `${name}.txt`);
    const fallbackEnPath = path.join(this.baseDir, "en", "default", `${name}.txt`);

    let filePath = variantPath;
    if (!fs.existsSync(filePath)) filePath = defaultPath;
    if (!fs.existsSync(filePath)) filePath = fallbackEnPath;

    const content = fs.readFileSync(filePath, "utf8");
    this.cache.set(key, content);
    return content;
  }

  render(name: string, vars: Record<string, string | number>): string {
    let text = this.loadTemplate(name);
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
    return text;
  }
}
