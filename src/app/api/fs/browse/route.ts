import { NextResponse } from "next/server";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const dynamic = "force-dynamic";

export interface DirEntry {
  name: string;
  path: string;
  hasBeads: boolean;
}

/**
 * Directory browser for the Add-project flow. Lists sub-directories of `path` (defaulting to the
 * user's home dir), flagging which ones contain a `.beads/` directory. Local single-user app, so
 * filesystem reads are expected — but we only ever read directory listings, never file contents.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = url.searchParams.get("path");
  const path = resolve(requested && requested.trim() ? requested : homedir());

  if (!existsSync(path)) {
    return NextResponse.json({ error: `Path does not exist: ${path}` }, { status: 404 });
  }

  let dirents;
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read directory";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const entries: DirEntry[] = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => {
      const full = join(path, d.name);
      return { name: d.name, path: full, hasBeads: existsSync(join(full, ".beads")) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = dirname(path);

  return NextResponse.json({
    path,
    parent: parent === path ? null : parent,
    home: homedir(),
    hasBeads: existsSync(join(path, ".beads")),
    entries,
  });
}
