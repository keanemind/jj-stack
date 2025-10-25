import { execFile } from "child_process"; // Changed from 'exec' to 'execFile'
import type {
  LogEntry,
  Bookmark,
  BranchStack,
  ChangeGraph,
  BookmarkSegment,
  JjConfig,
} from "./jjTypes.js";
import * as v from "valibot";
import { logger } from "./logger.js";

// Types for dependency injection
export type JjFunctions = {
  gitFetch: () => Promise<void>;
  getMyBookmarks: () => Promise<Bookmark[]>;
  getBranchChangesPaginated: (
    from: string,
    to: string,
    lastSeenCommit?: string,
  ) => Promise<LogEntry[]>;
  getGitRemoteList: () => Promise<Array<{ name: string; url: string }>>;
  getDefaultBranch: () => Promise<string>;
  getRoot: () => Promise<string>;
  pushBookmark: (bookmarkName: string, remote: string) => Promise<void>;
};

/**
 * Check if a remote URL points to GitHub.com
 * Supports both HTTPS and SSH formats:
 * - HTTPS: https://github.com/owner/repo.git
 * - SSH: git@github.com:owner/repo.git
 */
export function isGitHubRemote(remoteUrl: string): boolean {
  // Match github.com (including subdomains like company.github.com)
  // This supports both HTTPS and SSH formats:
  // HTTPS: https://github.com/owner/repo.git, https://company.github.com/owner/repo.git
  // SSH: git@github.com:owner/repo.git, git@company.github.com:owner/repo.git
  return /github\.com[:/]/.test(remoteUrl);
}

/**
 * Filter a list of remotes to only include GitHub.com remotes
 */
export function filterGitHubRemotes(
  remotes: Array<{ name: string; url: string }>,
): Array<{ name: string; url: string }> {
  return remotes.filter((remote) => isGitHubRemote(remote.url));
}

/**
 * Create configured JjFunctions from a config object
 */
export function createJjFunctions(config: JjConfig): JjFunctions {
  return {
    gitFetch: () => gitFetch(config),
    getMyBookmarks: () => getMyBookmarks(config),
    getBranchChangesPaginated: (from, to, lastSeenCommit) =>
      getBranchChangesPaginated(config, from, to, lastSeenCommit),
    getGitRemoteList: () => getGitRemoteList(config),
    getDefaultBranch: () => getDefaultBranch(config),
    pushBookmark: (bookmarkName, remote) =>
      pushBookmark(config, bookmarkName, remote),
    getRoot: () => getRoot(config),
  };
}

/**
 * Returns the root of the repository
 */
function getRoot(config: JjConfig): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      config.binaryPath,
      ["root"],
      (error, stdout, stderr) => {
        if (error) {
          logger.error(
            `Failed to find repo root: ${(error as Error).toString()}`,
          );
          return reject(error as Error);
        }
        if (stderr) {
          logger.warn(`Got stderr response on jj root: ${stderr}`);
        }
        resolve(stdout.trim());
      },
    );
  });
}

/**
 * Fetch latest changes from all git remotes
 */
function gitFetch(config: JjConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      config.binaryPath,
      ["git", "fetch", "--all-remotes"],
      (error, stdout, stderr) => {
        if (error) {
          logger.error(
            `Failed to fetch from remotes: ${(error as Error).toString()}`,
          );
          return reject(error as Error);
        }
        if (stderr) {
          logger.warn(`Git fetch warnings: ${stderr}`);
        }
        logger.debug("Successfully fetched from all remotes");
        resolve();
      },
    );
  });
}

const BookmarkOutputSchema = v.object({
  name: v.string(),
  commitId: v.string(),
  changeId: v.string(),
  localBookmarks: v.array(v.string()),
  remoteBookmarks: v.array(v.string()),
});

/**
 * Get all bookmarks created by the current user
 */
function getMyBookmarks(config: JjConfig): Promise<Bookmark[]> {
  return new Promise((resolve, reject) => {
    const bookmarkTemplate = `'{ "name":' ++ name.escape_json() ++ ', ' ++
    '"commitId":' ++ normal_target.commit_id().short().escape_json() ++ ', ' ++
    '"changeId":' ++ normal_target.change_id().short().escape_json() ++ ', ' ++
    '"localBookmarks": [' ++ normal_target.local_bookmarks().map(|b| b.name().escape_json()).join(",") ++ '], ' ++
    '"remoteBookmarks": [' ++ normal_target.remote_bookmarks().map(|b| stringify(b.name() ++ "@" ++ b.remote()).escape_json()).join(",") ++ '] }\n'`;

    execFile(
      config.binaryPath,
      [
        "bookmark",
        "list",
        "--revisions",
        "mine() ~ trunk()",
        "--template",
        bookmarkTemplate,
      ],
      (error, stdout, stderr) => {
        if (error) {
          logger.error(
            `Failed to get bookmarks: ${(error as Error).toString()}`,
          );
          return reject(error as Error);
        }
        if (stderr) {
          logger.error(`stderr: ${stderr}`);
        }

        const bookmarks = new Map<string, Bookmark>();
        const lines = stdout.trim().split("\n");

        for (const line of lines) {
          if (line.trim() === "") continue;

          try {
            const bookmark = v.parse(BookmarkOutputSchema, JSON.parse(line));
            const hasMatchingRemote = bookmark.remoteBookmarks.some((remote) =>
              remote.startsWith(bookmark.name + "@") && remote !== bookmark.name + "@git",
            );

            const existingBookmark = bookmarks.get(bookmark.name);
            if (!existingBookmark) {
              bookmarks.set(bookmark.name, {
                name: bookmark.name,
                commitId: bookmark.commitId,
                changeId: bookmark.changeId,
                hasRemote: hasMatchingRemote,
                isSynced: !!bookmark.localBookmarks.length && hasMatchingRemote,
              });
            } else {
              existingBookmark.hasRemote ||= hasMatchingRemote;
              if (
                !bookmark.localBookmarks.length &&
                bookmark.remoteBookmarks.length
              ) {
                // We found a tracked remote bookmark that points to a commit without local bookmarks.
                // This means the local bookmark has at least one out of sync remote.
                existingBookmark.isSynced = false;
              }
            }
          } catch (error) {
            logger.error(`Failed to parse bookmark line: ${line}`, error);
            reject(error as Error);
            return;
          }
        }

        resolve(Array.from(bookmarks.values()));
      },
    );
  });
}

const LogEntrySchema = v.object({
  commitId: v.string(),
  changeId: v.string(),
  authorName: v.string(),
  authorEmail: v.string(),
  descriptionFirstLine: v.string(),
  parents: v.array(v.string()),
  localBookmarks: v.array(v.string()),
  remoteBookmarks: v.array(v.string()),
  isCurrentWorkingCopy: v.boolean(),
  authoredAt: v.pipe(v.string(), v.isoTimestamp()),
  committedAt: v.pipe(v.string(), v.isoTimestamp()),
});

/**
 * Get changes that are ancestors of `to` that are not ancestors of `trunk`. The result
 * will include `to` itself, but not `trunk`.
 */
function getBranchChangesPaginated(
  config: JjConfig,
  trunk: string,
  to: string,
  lastSeenCommit?: string,
): Promise<LogEntry[]> {
  return new Promise((resolve, reject) => {
    const jjTemplate = `'{ "commitId":' ++ commit_id.short().escape_json() ++ ', ' ++ '"changeId":' 
++ change_id.short().escape_json() ++ ', ' ++ '"authorName":' ++ author.name().escape_json() ++ 
', ' ++ '"authorEmail":' ++ stringify(author.email().local() ++ '@' ++
author.email().domain()).escape_json() ++ ', ' ++ '"descriptionFirstLine":' ++ 
description.first_line().trim().escape_json() ++ ', ' ++ '"parents": [' ++ parents.map(|p| 
p.commit_id().short().escape_json()).join(",") ++ '], ' ++ '"localBookmarks": [' ++ 
local_bookmarks.map(|b| b.name().escape_json()).join(",") ++ '], ' ++ '"remoteBookmarks": [' ++
remote_bookmarks.map(|b| stringify(b.name() ++ '@' ++ b.remote()).escape_json()).join(",") ++ 
'], ' ++ '"isCurrentWorkingCopy":' ++ current_working_copy ++ ', ' ++
'"authoredAt":' ++ author.timestamp().format('%+').escape_json() ++ ', ' ++
'"committedAt":' ++ committer.timestamp().format('%+').escape_json() ++ ' }\n'`;

    // Build revset: trunk..to but exclude already seen commits
    const revset = lastSeenCommit
      ? `(${trunk}..${to}) ~ ${lastSeenCommit}::`
      : `${trunk}..${to}`;

    execFile(
      config.binaryPath,
      [
        "log",
        "--revisions",
        revset,
        "--no-graph",
        "--limit",
        "100",
        "--template",
        jjTemplate,
      ],
      (error, stdout, stderr) => {
        if (error) {
          logger.error(
            `Failed to get changes (trunk ${trunk}, to ${to}): ${(error as Error).toString()}`,
          );
          return reject(error as Error);
        }
        if (stderr) {
          logger.error(`stderr: ${stderr}`);
        }

        const changes: LogEntry[] = [];
        const lines = stdout.trim().split("\n");

        for (const line of lines) {
          if (line.trim() === "") continue;
          try {
            const rawChange = v.parse(LogEntrySchema, JSON.parse(line));
            changes.push({
              commitId: rawChange.commitId,
              changeId: rawChange.changeId,
              authorName: rawChange.authorName,
              authorEmail: rawChange.authorEmail,
              descriptionFirstLine: rawChange.descriptionFirstLine,
              parents: rawChange.parents,
              localBookmarks: rawChange.localBookmarks,
              remoteBookmarks: rawChange.remoteBookmarks,
              isCurrentWorkingCopy: rawChange.isCurrentWorkingCopy,
              authoredAt: new Date(rawChange.authoredAt),
              committedAt: new Date(rawChange.committedAt),
            });
          } catch (parseError) {
            logger.error(`Failed to parse line: ${line}`, parseError);
            reject(
              new Error(
                `Failed to parse JJ log output: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
              ),
            );
            return;
          }
        }

        resolve(changes);
      },
    );
  });
}

/**
 * Traverse from a bookmark toward trunk, discovering segments and relationships along the way
 */
async function traverseAndDiscoverSegments(
  bookmark: Bookmark,
  trunkRev: string,
  fullyCollectedBookmarks: Set<string>,
  taintedChangeIds: Set<string>,
  jj: JjFunctions,
): Promise<{
  segments: Array<{ bookmarks: string[]; changes: LogEntry[] }>;
  alreadySeenChangeId?: string; // if we hit a fully-collected bookmark
  excludedBookmarkCount: number; // count of bookmarks excluded due to merge taint
}> {
  const segments: Array<{ bookmarks: string[]; changes: LogEntry[] }> = [];
  let currentSegment: { bookmarks: string[]; changes: LogEntry[] } | undefined =
    undefined;
  let lastSeenCommit: string | undefined;
  let alreadySeenChangeId: string | undefined;
  const seenChangeIds: string[] = []; // AIDEV-NOTE: Track all changeIds seen during this bookmark's traversal

  pageLoop: while (true) {
    const changes = await jj.getBranchChangesPaginated(
      trunkRev,
      bookmark.commitId,
      lastSeenCommit,
    );

    if (changes.length === 0) {
      break;
    }

    // Check for merge commits or already-tainted changes
    for (const change of changes) {
      seenChangeIds.push(change.changeId);

      // Check if this change is a merge commit or already tainted
      if (change.parents.length > 1 || taintedChangeIds.has(change.changeId)) {
        logger.debug(
          `Found ${change.parents.length > 1 ? "merge commit" : "tainted change"} ${change.commitId} in bookmark ${bookmark.name} - excluding bookmark and descendants`,
        );

        // Add all seen changeIds to the tainted set
        for (const seenChangeId of seenChangeIds) {
          taintedChangeIds.add(seenChangeId);
        }

        return {
          segments: [],
          excludedBookmarkCount: 1,
        };
      }
    }

    // Check each change for bookmarks, stopping if we find a fully-collected one
    for (const change of changes) {
      if (change.localBookmarks.length) {
        if (currentSegment) {
          segments.push(currentSegment);
        }
        if (change.localBookmarks.some((b) => fullyCollectedBookmarks.has(b))) {
          logger.debug(
            `    Found fully-collected bookmark at ${change.commitId}`,
          );
          alreadySeenChangeId = change.changeId;
          currentSegment = undefined; // So it doesn't get re-added at the end
          break pageLoop;
        } else {
          currentSegment = {
            bookmarks: change.localBookmarks,
            changes: [],
          };
        }
        logger.debug(
          `    Starting new segment for bookmarks: ${change.localBookmarks.join(
            ", ",
          )} at commit ${change.commitId}`,
        );
      }
      if (!currentSegment) {
        throw new Error(
          "No current segment initialized, but we have changes to process",
        );
      }
      currentSegment.changes.push(change);
    }

    if (changes.length < 100) {
      break; // We got all remaining changes
    }

    // Use the oldest commit in this batch as the cursor for the next page
    lastSeenCommit = changes[changes.length - 1].commitId;
  }

  if (currentSegment) {
    segments.push(currentSegment);
  }

  return {
    segments,
    alreadySeenChangeId,
    excludedBookmarkCount: 0,
  };
}

/**
 * Group segments into stacks based on their relationships
 * Creates one stack per leaf bookmark, with each stack representing the full path from trunk to that leaf
 */
function groupSegmentsIntoStacks(
  bookmarks: Map<string, Bookmark>,
  stackLeafs: Set<string>,
  bookmarkedChangeAdjacencyList: Map<string, string>,
  bookmarkedChangeIdToSegment: Map<string, LogEntry[]>,
): BranchStack[] {
  const stacks: BranchStack[] = [];

  // Helper function to build a path from a leaf bookmark back to the root
  function buildPathToRoot(leafChangeId: string): string[] {
    const path: string[] = [leafChangeId];
    let current = leafChangeId;

    // Walk backwards through the stacking relationships to build the full path
    while (bookmarkedChangeAdjacencyList.has(current)) {
      const parent = bookmarkedChangeAdjacencyList.get(current)!;
      path.push(parent);
      current = parent;
    }

    return path.reverse();
  }

  // Helper function to build segments from a list of bookmark names
  function buildSegments(stackChangeIds: string[]): BookmarkSegment[] {
    const segments: BookmarkSegment[] = [];

    for (const changeId of stackChangeIds) {
      const segment = bookmarkedChangeIdToSegment.get(changeId)!;

      segments.push({
        bookmarks: segment[0].localBookmarks.map(
          (bookmarkName) => bookmarks.get(bookmarkName)!,
        ),
        changes: segment,
      });
    }

    return segments;
  }

  // Find all leaf bookmarks and create a stack for each
  for (const leafChangeId of stackLeafs) {
    const stackChangeIds = buildPathToRoot(leafChangeId);
    const segments = buildSegments(stackChangeIds);

    stacks.push({
      segments,
    });
  }

  return stacks;
}

/**
 * Build a complete change graph by discovering all bookmark segments and their relationships
 */
export async function buildChangeGraph(jj: JjFunctions): Promise<ChangeGraph> {
  const jjFunctions = jj;

  logger.debug("Discovering user bookmarks...");
  const bookmarks = await jjFunctions.getMyBookmarks();

  logger.debug(
    `Found ${bookmarks.length} bookmarks: ${bookmarks.map((b) => b.name).join(", ")}`,
  );

  const bookmarksByName = new Map<string, Bookmark>(
    bookmarks.map((b) => [b.name, b]),
  );

  // Data structures for the optimized algorithm
  const fullyCollectedBookmarks = new Set<string>();
  const bookmarkToChangeId = new Map<string, string>(); // bookmarkName -> changeId
  const bookmarkedChangeAdjacencyList = new Map<string, string>(); // child (changeId) -> parent (changeId)
  const bookmarkedChangeIdToSegment = new Map<string, LogEntry[]>(); // changeId -> all LogEntrys in that segment
  const stackRoots = new Set<string>(); // changeIds that are the lowest bookmark in a stack excluding trunk() ancestors
  const taintedChangeIds = new Set<string>(); // AIDEV-NOTE: changeIds that are merge commits or descendants of merges
  let totalExcludedBookmarkCount = 0; // AIDEV-NOTE: Total count of bookmarks excluded due to merges

  // Process each bookmark to collect segment changes
  for (const bookmark of bookmarks) {
    if (fullyCollectedBookmarks.has(bookmark.name)) {
      logger.debug(`Skipping already processed bookmark: ${bookmark.name}`);
      continue;
    }

    logger.debug(`Processing bookmark: ${bookmark.name}`);

    try {
      const trunkRev = "trunk()";

      // Use optimized collection that can stop early when hitting fully-collected bookmarks
      const result = await traverseAndDiscoverSegments(
        bookmark,
        trunkRev,
        fullyCollectedBookmarks,
        taintedChangeIds,
        jjFunctions,
      );

      // Handle excluded bookmarks (those that encountered merges)
      if (result.excludedBookmarkCount > 0) {
        totalExcludedBookmarkCount += result.excludedBookmarkCount;
        logger.debug(
          `  Excluded ${bookmark.name} due to merge commit in history`,
        );
        continue; // Skip processing this bookmark
      }

      // Store segment changes for all bookmarks found in the result
      for (const segment of result.segments) {
        bookmarkedChangeIdToSegment.set(
          segment.changes[0].changeId,
          segment.changes,
        );
        for (const bookmark of segment.bookmarks) {
          bookmarkToChangeId.set(bookmark, segment.changes[0].changeId);
          fullyCollectedBookmarks.add(bookmark);
        }
        logger.debug(
          `    Found segment for [${segment.bookmarks.join(", ")}]: ${segment.changes.length} changes`,
        );
      }

      // Establish stacking relationships based on the segment order
      // Segments are returned in order from target back to base, so we need to reverse for stacking
      for (let i = 0; i < result.segments.length - 1; i++) {
        const childSegment = result.segments[i];
        const parentSegment = result.segments[i + 1];
        bookmarkedChangeAdjacencyList.set(
          childSegment.changes[0].changeId,
          parentSegment.changes[0].changeId,
        );
        logger.debug(
          `    Stacking: [${childSegment.bookmarks.join(", ")}] -> [${parentSegment.bookmarks.join(", ")}]`,
        );
      }

      // If we hit a fully-collected bookmark, establish relationship to it
      if (result.alreadySeenChangeId && result.segments.length > 0) {
        const rootSegment = result.segments[result.segments.length - 1];
        bookmarkedChangeAdjacencyList.set(
          rootSegment.changes[0].changeId,
          result.alreadySeenChangeId,
        );
        logger.debug(
          `    Stacking: [${rootSegment.bookmarks.join(", ")}] -> [${bookmarkedChangeIdToSegment.get(result.alreadySeenChangeId)![0].localBookmarks.join(", ")}]`,
        );
      } else if (result.segments.length > 0) {
        // We reached trunk, so the last segment is a root
        const rootSegment = result.segments[result.segments.length - 1];
        stackRoots.add(rootSegment.changes[0].changeId);
        for (const bookmark of rootSegment.bookmarks) {
          logger.debug(`    Root bookmark identified: ${bookmark}`);
        }
      } else {
        // No segments were found, meaning the bookmark is on an ancestor of trunk()
        // Note: a given change is an ancestor of itself, so the bookmark may have been on the same change as trunk()
      }

      logger.debug(
        `  Processed ${bookmark.name} - found ${result.segments.length} segments`,
      );
    } catch (error) {
      logger.error(`Failed to process bookmark ${bookmark.name}:`, error);
      throw error;
    }
  }

  const changeIdsWithChildren = new Set(bookmarkedChangeAdjacencyList.values());
  const stackLeafs = new Set(
    [...bookmarkedChangeIdToSegment.keys()].filter(
      (changeId) => !changeIdsWithChildren.has(changeId),
    ),
  ); // changeIds that are leafs in the stack (no children, in-degree 0)

  // Debug: log the stacking relationships we discovered
  logger.debug("=== STACKING RELATIONSHIPS ===");
  for (const [child, parent] of bookmarkedChangeAdjacencyList.entries()) {
    logger.debug(
      `[${bookmarkedChangeIdToSegment.get(child)![0].localBookmarks.join(", ")}] -> [${bookmarkedChangeIdToSegment.get(parent)![0].localBookmarks.join(", ")}]`,
    );
  }
  for (const changeId of stackRoots) {
    logger.debug(
      `[${bookmarkedChangeIdToSegment.get(changeId)![0].localBookmarks.join(", ")}] -> trunk()`,
    );
  }
  if (bookmarkedChangeIdToSegment.size === 0 && stackRoots.size === 0) {
    logger.debug("No stacking relationships found");
  }

  // Group segments into stacks based on relationships
  const stacks = groupSegmentsIntoStacks(
    bookmarksByName,
    stackLeafs,
    bookmarkedChangeAdjacencyList,
    bookmarkedChangeIdToSegment,
  );

  return {
    bookmarks: bookmarksByName,
    bookmarkToChangeId,
    bookmarkedChangeAdjacencyList,
    bookmarkedChangeIdToSegment,
    stackLeafs,
    stackRoots,
    stacks,
    excludedBookmarkCount: totalExcludedBookmarkCount,
  };
}

/**
 * Get git remote list using JJ
 */
function getGitRemoteList(
  config: JjConfig,
): Promise<Array<{ name: string; url: string }>> {
  return new Promise((resolve, reject) => {
    execFile(
      config.binaryPath,
      ["git", "remote", "list"],
      (error, stdout, stderr) => {
        if (error) {
          logger.error(
            `Failed to get git remotes: ${(error as Error).toString()}`,
          );
          return reject(error as Error);
        }
        if (stderr) {
          logger.warn(`Git remote list warnings: ${stderr}`);
        }

        const lines = stdout.trim().split("\n");
        const remotes: Array<{ name: string; url: string }> = [];

        for (const line of lines) {
          // JJ git remote list format: "remote_name url"
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) {
            remotes.push({ name: parts[0], url: parts[1] });
          }
        }

        resolve(remotes);
      },
    );
  });
}

const RemoteBookmarksSchema = v.array(v.string());
/**
 * Get the default branch name for the repository by finding what trunk() resolves to
 */
function getDefaultBranch(config: JjConfig): Promise<string> {
  return new Promise((resolve, reject) => {
    const template = `'[ ' ++ remote_bookmarks.map(|b| b.name().escape_json()).join(",") ++ ']\n'`;

    execFile(
      config.binaryPath,
      [
        "log",
        "--revisions",
        "trunk()",
        "--no-graph",
        "--limit",
        "1",
        "--template",
        template,
      ],
      (error, stdout, stderr) => {
        if (error) {
          logger.error(
            `Failed to get default branch: ${(error as Error).toString()}`,
          );
          return reject(error as Error);
        }
        if (stderr) {
          logger.warn(`Get default branch warnings: ${stderr}`);
        }

        let remoteBookmarks: string[];
        try {
          remoteBookmarks = v.parse(
            RemoteBookmarksSchema,
            JSON.parse(stdout.trim()),
          );
        } catch (e) {
          const parseError = new Error(
            `Failed to parse remote bookmarks from jj log output: ${String(e)}`,
          );
          logger.error(parseError.message);
          return reject(parseError);
        }

        const candidates = ["main", "master", "trunk"];
        for (const candidate of candidates) {
          if (remoteBookmarks.includes(candidate)) {
            resolve(candidate);
            return;
          }
        }

        const notFoundError = new Error(
          `Could not find a remote bookmark for default branch (main, master, or trunk) in: ${JSON.stringify(remoteBookmarks)}`,
        );
        logger.error(notFoundError.message);
        reject(notFoundError);
      },
    );
  });
}

/**
 * Push the bookmark to the remote using JJ
 */
function pushBookmark(
  config: JjConfig,
  bookmarkName: string,
  remote: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      config.binaryPath,
      [
        "git",
        "push",
        "--remote",
        remote,
        "--bookmark",
        bookmarkName,
        "--allow-new",
      ],
      (error, stdout, stderr) => {
        if (error) {
          logger.error(
            `Failed to push bookmark ${bookmarkName}: ${(error as Error).toString()}`,
          );
          return reject(error as Error);
        }
        if (stderr) {
          logger.warn(`Push bookmark warnings: ${stderr}`);
        }

        logger.debug(
          `Successfully pushed bookmark ${bookmarkName} to ${remote}`,
        );
        resolve();
      },
    );
  });
}
