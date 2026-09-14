// 深度区间模块的持久化层：JSON 文件 + 原子写（tmp + rename），重启后重建派生状态。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { emptyState, hydrateState, serializeState } from "./depth-lib.js";

export class DepthStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = emptyState();
  }

  async load() {
    if (!existsSync(this.filePath)) {
      this.state = emptyState();
      await this.save();
      return this.state;
    }
    const raw = await readFile(this.filePath, "utf8");
    this.state = raw.trim() ? hydrateState(JSON.parse(raw)) : emptyState();
    return this.state;
  }

  async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(serializeState(this.state), null, 2));
    await rename(tmp, this.filePath); // 同目录 rename 保证原子替换，崩溃不留半个文件
  }
}
