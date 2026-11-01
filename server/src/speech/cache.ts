import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Cache of synthesized phrases: frequent lines cost no characters and play instantly. */
export class TtsCache {
  constructor(private dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  private file(key: string) {
    return path.join(this.dir, crypto.createHash("sha1").update(key).digest("hex") + ".mp3");
  }
  get(key: string): Buffer | null {
    const f = this.file(key);
    return fs.existsSync(f) ? fs.readFileSync(f) : null;
  }
  put(key: string, data: Buffer) { fs.writeFileSync(this.file(key), data); }
}
