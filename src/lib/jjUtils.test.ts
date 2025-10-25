import {
  buildChangeGraph,
  isGitHubRemote,
  filterGitHubRemotes,
  type JjFunctions,
} from "./jjUtils.js";
import type { LogEntry, Bookmark } from "./jjTypes.js";
import assert from "assert/strict";

suite("stack detection", () => {
  test("simple", async () => {
    console.log("\n=== Testing buildChangeGraph branching scenario ===");

    // Setup: A -> B (bookmark3) -> C (bookmark1)
    //                          \-> D (bookmark2)

    const mockBookmarks: Bookmark[] = [
      {
        name: "bookmark1",
        commitId: "commit_c",
        changeId: "change_c",
        hasRemote: false,
        isSynced: false,
      },
      {
        name: "bookmark2",
        commitId: "commit_d",
        changeId: "change_d",
        hasRemote: false,
        isSynced: false,
      },
      {
        name: "bookmark3",
        commitId: "commit_b",
        changeId: "change_b",
        hasRemote: false,
        isSynced: false,
      },
    ];

    const mockLogEntries: LogEntry[] = [
      {
        commitId: "commit_a",
        changeId: "change_a",
        authorName: "Test",
        authorEmail: "test@example.com",
        descriptionFirstLine: "Change A (trunk)",
        parents: [],
        localBookmarks: [],
        remoteBookmarks: [],
        isCurrentWorkingCopy: false,
        authoredAt: new Date(),
        committedAt: new Date(),
      },
      {
        commitId: "commit_b",
        changeId: "change_b",
        authorName: "Test",
        authorEmail: "test@example.com",
        descriptionFirstLine: "Change B",
        parents: ["commit_a"],
        localBookmarks: ["bookmark3"],
        remoteBookmarks: [],
        isCurrentWorkingCopy: false,
        authoredAt: new Date(),
        committedAt: new Date(),
      },
      {
        commitId: "commit_c",
        changeId: "change_c",
        authorName: "Test",
        authorEmail: "test@example.com",
        descriptionFirstLine: "Change C",
        parents: ["commit_b"],
        localBookmarks: ["bookmark1"],
        remoteBookmarks: [],
        isCurrentWorkingCopy: false,
        authoredAt: new Date(),
        committedAt: new Date(),
      },
      {
        commitId: "commit_d",
        changeId: "change_d",
        authorName: "Test",
        authorEmail: "test@example.com",
        descriptionFirstLine: "Change D",
        parents: ["commit_b"],
        localBookmarks: ["bookmark2"],
        remoteBookmarks: [],
        isCurrentWorkingCopy: false,
        authoredAt: new Date(),
        committedAt: new Date(),
      },
    ];

    // AIDEV-NOTE: Using factory pattern mock setup (config is passed at factory creation)

    const mockJj: JjFunctions = {
      gitFetch: () => Promise.resolve(),

      getMyBookmarks: () => Promise.resolve(mockBookmarks),

      getBranchChangesPaginated: (_from: string, to: string) => {
        // Return changes between trunk (commit_a) and target commit
        if (to === "commit_c") {
          // bookmark1: changes from trunk to C = [C, B] (newest first)
          return Promise.resolve([mockLogEntries[2], mockLogEntries[1]]);
        } else if (to === "commit_d") {
          // bookmark2: changes from trunk to D = [D, B] (newest first)
          return Promise.resolve([mockLogEntries[3], mockLogEntries[1]]);
        } else if (to === "commit_b") {
          // bookmark3: changes from trunk to B = [B]
          return Promise.resolve([mockLogEntries[1]]);
        }
        return Promise.resolve([]);
      },

      getGitRemoteList: () =>
        Promise.resolve([
          { name: "origin", url: "https://github.com/test/repo.git" },
        ]),
      getDefaultBranch: () => Promise.resolve("main"),
      pushBookmark: () => Promise.resolve(),
      getRoot: () => Promise.resolve("."),
    };

    const result = await buildChangeGraph(mockJj);

    // Expected: Two stacks
    // Stack 1: trunk -> bookmark3 -> bookmark1
    // Stack 2: trunk -> bookmark3 -> bookmark2

    console.log(`Number of stacks: ${result.stacks.length}`);

    assert.strictEqual(
      result.stacks.length,
      2,
      `Expected 2 stacks, got ${result.stacks.length}`,
    );

    // AIDEV-NOTE: Verify no bookmarks were excluded since this scenario has no merges
    assert.strictEqual(
      result.excludedBookmarkCount,
      0,
      `Expected 0 excluded bookmarks, got ${result.excludedBookmarkCount}`,
    );

    // Each stack should have 2 segments
    assert.strictEqual(
      result.stacks[0].segments.length,
      2,
      `Expected stack 0 to have 2 segments, got ${result.stacks[0].segments.length}`,
    );
    assert.strictEqual(
      result.stacks[1].segments.length,
      2,
      `Expected stack 1 to have 2 segments, got ${result.stacks[1].segments.length}`,
    );

    // Both stacks should start with bookmark3 as the first segment
    assert.strictEqual(
      result.stacks[0].segments[0].bookmarks[0].name,
      "bookmark3",
      `Expected stack 0 first segment to be bookmark3, got ${result.stacks[0].segments[0].bookmarks[0].name}`,
    );
    assert.strictEqual(
      result.stacks[1].segments[0].bookmarks[0].name,
      "bookmark3",
      `Expected stack 1 first segment to be bookmark3, got ${result.stacks[1].segments[0].bookmarks[0].name}`,
    );

    // The bookmark3 segments should contain change B
    assert.ok(
      result.stacks[0].segments[0].changes.length === 1 &&
        result.stacks[0].segments[0].changes[0].changeId === "change_b",
      `Expected stack 0 bookmark3 segment to contain change_b`,
    );
    assert.ok(
      result.stacks[1].segments[0].changes.length === 1 &&
        result.stacks[1].segments[0].changes[0].changeId === "change_b",
      `Expected stack 1 bookmark3 segment to contain change_b`,
    );

    // One stack should end with bookmark1, the other with bookmark2
    const stack1LastSegment = result.stacks[0].segments[1];
    const stack2LastSegment = result.stacks[1].segments[1];

    const endBookmarks = [
      stack1LastSegment.bookmarks[0].name,
      stack2LastSegment.bookmarks[0].name,
    ];
    assert.ok(
      endBookmarks.includes("bookmark1") && endBookmarks.includes("bookmark2"),
      `Expected stacks to end with bookmark1 and bookmark2, got ${endBookmarks.join(", ")}`,
    );

    // The tip segments should contain the correct changes
    if (stack1LastSegment.bookmarks[0].name === "bookmark1") {
      assert.ok(
        stack1LastSegment.changes.length === 1 &&
          stack1LastSegment.changes[0].changeId === "change_c",
        `Expected bookmark1 segment to contain change_c`,
      );
      assert.ok(
        stack2LastSegment.changes.length === 1 &&
          stack2LastSegment.changes[0].changeId === "change_d",
        `Expected bookmark2 segment to contain change_d`,
      );
    } else {
      assert.ok(
        stack1LastSegment.changes.length === 1 &&
          stack1LastSegment.changes[0].changeId === "change_d",
        `Expected bookmark2 segment to contain change_d`,
      );
      assert.ok(
        stack2LastSegment.changes.length === 1 &&
          stack2LastSegment.changes[0].changeId === "change_c",
        `Expected bookmark1 segment to contain change_c`,
      );
    }

    // Verify segmentChanges map
    const bookmark1Changes = result.bookmarkedChangeIdToSegment.get(
      result.bookmarkToChangeId.get("bookmark1")!,
    );
    const bookmark2Changes = result.bookmarkedChangeIdToSegment.get(
      result.bookmarkToChangeId.get("bookmark2")!,
    );
    const bookmark3Changes = result.bookmarkedChangeIdToSegment.get(
      result.bookmarkToChangeId.get("bookmark3")!,
    );

    assert.ok(
      bookmark1Changes &&
        bookmark1Changes.length === 1 &&
        bookmark1Changes[0].changeId === "change_c",
      `Expected bookmark1 segmentChanges to contain change_c`,
    );
    assert.ok(
      bookmark2Changes &&
        bookmark2Changes.length === 1 &&
        bookmark2Changes[0].changeId === "change_d",
      `Expected bookmark2 segmentChanges to contain change_d`,
    );
    assert.ok(
      bookmark3Changes &&
        bookmark3Changes.length === 1 &&
        bookmark3Changes[0].changeId === "change_b",
      `Expected bookmark3 segmentChanges to contain change_b`,
    );
  });

  test("complex", async () => {
    console.log("\n=== Testing complex branching scenario ===");

    // AIDEV-NOTE: Using factory pattern mock setup (config is passed at factory creation)

    // Setup: A complex tree structure
    // trunk -> bookmark1 -> bookmark2 -> bookmark3
    //                             \-> bookmark4 -> bookmark5
    //                                        \-> bookmark6
    //
    // This tests multiple children at a non-root level (bookmark2 has children bookmark3 and bookmark4)
    // and bookmark4 also has multiple children (bookmark5 and bookmark6)
    // Expected: 3 stacks (one for each leaf: bookmark3, bookmark5, bookmark6)

    const mockBookmarks: Bookmark[] = [
      {
        name: "bookmark1",
        commitId: "commit_b",
        changeId: "change_b",
        hasRemote: false,
        isSynced: false,
      },
      {
        name: "bookmark2",
        commitId: "commit_c",
        changeId: "change_c",
        hasRemote: false,
        isSynced: false,
      },
      {
        name: "bookmark3",
        commitId: "commit_d",
        changeId: "change_d",
        hasRemote: false,
        isSynced: false,
      },
      {
        name: "bookmark4",
        commitId: "commit_e",
        changeId: "change_e",
        hasRemote: false,
        isSynced: false,
      },
      {
        name: "bookmark5",
        commitId: "commit_f",
        changeId: "change_f",
        hasRemote: false,
        isSynced: false,
      },
      {
        name: "bookmark6",
        commitId: "commit_g",
        changeId: "change_g",
        hasRemote: false,
        isSynced: false,
      },
    ];

    const mockLogEntries: LogEntry[] = [
      {
        commitId: "commit_a",
        changeId: "change_a",
        authorName: "Test",
        authorEmail: "test@example.com",
        descriptionFirstLine: "Change A (trunk)",
        parents: [],
        localBookmarks: [],
        remoteBookmarks: [],
        isCurrentWorkingCopy: false,
        authoredAt: new Date(),
        committedAt: new Date(),
      },
      {
        commitId: "commit_b",
        changeId: "change_b",
        authorName: "Test",
        authorEmail: "test@example.com",
        descriptionFirstLine: "Change B",
        parents: ["commit_a"],
        localBookmarks: ["bookmark1"],
        remoteBookmarks: [],
        isCurrentWorkingCopy: false,
        authoredAt: new Date(),
        committedAt: new Date(),
      },
      {
        commitId: "commit_c",
        changeId: "change_c",
        authorName: "Test",
        authorEmail: "test@example.com",
        descriptionFirstLine: "Change C",
        parents: ["commit_b"],
        localBookmarks: ["bookmark2"],
        remoteBookmarks: [],
        isCurrentWorkingCopy: false,
        authoredAt: new Date(),
        committedAt: new Date(),
      },
      {
        commitId: "commit_d",
        changeId: "change_d",
        authorName: "Test",
        authorEmail: "test@example.com",
        descriptionFirstLine: "Change D",
        parents: ["commit_c"],
        localBookmarks: ["bookmark3"],
        remoteBookmarks: [],
        isCurrentWorkingCopy: false,
        authoredAt: new Date(),
        committedAt: new Date(),
      },
      {
        commitId: "commit_e",
        changeId: "change_e",
        authorName: "Test",
        authorEmail: "test@example.com",
        descriptionFirstLine: "Change E",
        parents: ["commit_c"],
        localBookmarks: ["bookmark4"],
        remoteBookmarks: [],
        isCurrentWorkingCopy: false,
        authoredAt: new Date(),
        committedAt: new Date(),
      },
      {
        commitId: "commit_f",
        changeId: "change_f",
        authorName: "Test",
        authorEmail: "test@example.com",
        descriptionFirstLine: "Change F",
        parents: ["commit_e"],
        localBookmarks: ["bookmark5"],
        remoteBookmarks: [],
        isCurrentWorkingCopy: false,
        authoredAt: new Date(),
        committedAt: new Date(),
      },
      {
        commitId: "commit_g",
        changeId: "change_g",
        authorName: "Test",
        authorEmail: "test@example.com",
        descriptionFirstLine: "Change G",
        parents: ["commit_e"],
        localBookmarks: ["bookmark6"],
        remoteBookmarks: [],
        isCurrentWorkingCopy: false,
        authoredAt: new Date(),
        committedAt: new Date(),
      },
    ];

    const mockJj: JjFunctions = {
      gitFetch: () => Promise.resolve(),

      getMyBookmarks: () => Promise.resolve(mockBookmarks),

      getBranchChangesPaginated: (_from: string, to: string) => {
        // Return changes between trunk (commit_a) and target commit
        if (to === "commit_b") {
          // bookmark1: [B]
          return Promise.resolve([mockLogEntries[1]]);
        } else if (to === "commit_c") {
          // bookmark2: [C, B]
          return Promise.resolve([mockLogEntries[2], mockLogEntries[1]]);
        } else if (to === "commit_d") {
          // bookmark3: [D, C, B]
          return Promise.resolve([
            mockLogEntries[3],
            mockLogEntries[2],
            mockLogEntries[1],
          ]);
        } else if (to === "commit_e") {
          // bookmark4: [E, C, B]
          return Promise.resolve([
            mockLogEntries[4],
            mockLogEntries[2],
            mockLogEntries[1],
          ]);
        } else if (to === "commit_f") {
          // bookmark5: [F, E, C, B]
          return Promise.resolve([
            mockLogEntries[5],
            mockLogEntries[4],
            mockLogEntries[2],
            mockLogEntries[1],
          ]);
        } else if (to === "commit_g") {
          // bookmark6: [G, E, C, B]
          return Promise.resolve([
            mockLogEntries[6],
            mockLogEntries[4],
            mockLogEntries[2],
            mockLogEntries[1],
          ]);
        }
        return Promise.resolve([]);
      },

      getGitRemoteList: () =>
        Promise.resolve([
          { name: "origin", url: "https://github.com/test/repo.git" },
        ]),
      getDefaultBranch: () => Promise.resolve("main"),
      pushBookmark: () => Promise.resolve(),
      getRoot: () => Promise.resolve("."),
    };

    const result = await buildChangeGraph(mockJj);

    // Expected: Three stacks (one for each leaf)
    // Stack 1: trunk -> bookmark1 -> bookmark2 -> bookmark3
    // Stack 2: trunk -> bookmark1 -> bookmark2 -> bookmark4 -> bookmark5
    // Stack 3: trunk -> bookmark1 -> bookmark2 -> bookmark4 -> bookmark6

    console.log(`Number of stacks: ${result.stacks.length}`);

    assert.strictEqual(
      result.stacks.length,
      3,
      `Expected 3 stacks, got ${result.stacks.length}`,
    );

    // Verify that all leaf bookmarks are represented as the tip of exactly one stack
    const stackTips = result.stacks.map(
      (stack) => stack.segments[stack.segments.length - 1].bookmarks[0].name,
    );
    const expectedTips = ["bookmark3", "bookmark5", "bookmark6"];

    for (const expectedTip of expectedTips) {
      assert.ok(
        stackTips.includes(expectedTip),
        `Expected leaf bookmark ${expectedTip} to be a stack tip, but stack tips are: ${stackTips.join(", ")}`,
      );
    }

    // Verify that each stack has the correct structure
    for (const stack of result.stacks) {
      const stackTip =
        stack.segments[stack.segments.length - 1].bookmarks[0].name;

      if (stackTip === "bookmark3") {
        // Should be: bookmark1 -> bookmark2 -> bookmark3
        assert.strictEqual(
          stack.segments.length,
          3,
          `Stack ending with bookmark3 should have 3 segments, got ${stack.segments.length}`,
        );
        assert.ok(
          stack.segments[0].bookmarks[0].name === "bookmark1" &&
            stack.segments[1].bookmarks[0].name === "bookmark2" &&
            stack.segments[2].bookmarks[0].name === "bookmark3",
          `Stack ending with bookmark3 has wrong structure: ${stack.segments.map((s) => s.bookmarks[0].name).join(" -> ")}`,
        );
      } else if (stackTip === "bookmark5") {
        // Should be: bookmark1 -> bookmark2 -> bookmark4 -> bookmark5
        assert.strictEqual(
          stack.segments.length,
          4,
          `Stack ending with bookmark5 should have 4 segments, got ${stack.segments.length}`,
        );
        assert.ok(
          stack.segments[0].bookmarks[0].name === "bookmark1" &&
            stack.segments[1].bookmarks[0].name === "bookmark2" &&
            stack.segments[2].bookmarks[0].name === "bookmark4" &&
            stack.segments[3].bookmarks[0].name === "bookmark5",
          `Stack ending with bookmark5 has wrong structure: ${stack.segments.map((s) => s.bookmarks[0].name).join(" -> ")}`,
        );
      } else if (stackTip === "bookmark6") {
        // Should be: bookmark1 -> bookmark2 -> bookmark4 -> bookmark6
        assert.strictEqual(
          stack.segments.length,
          4,
          `Stack ending with bookmark6 should have 4 segments, got ${stack.segments.length}`,
        );
        assert.ok(
          stack.segments[0].bookmarks[0].name === "bookmark1" &&
            stack.segments[1].bookmarks[0].name === "bookmark2" &&
            stack.segments[2].bookmarks[0].name === "bookmark4" &&
            stack.segments[3].bookmarks[0].name === "bookmark6",
          `Stack ending with bookmark6 has wrong structure: ${stack.segments.map((s) => s.bookmarks[0].name).join(" -> ")}`,
        );
      }
    }

    // Verify segmentChanges map contains the right individual changes for each bookmark
    const bookmark1Changes = result.bookmarkedChangeIdToSegment.get(
      result.bookmarkToChangeId.get("bookmark1")!,
    );
    const bookmark2Changes = result.bookmarkedChangeIdToSegment.get(
      result.bookmarkToChangeId.get("bookmark2")!,
    );
    const bookmark3Changes = result.bookmarkedChangeIdToSegment.get(
      result.bookmarkToChangeId.get("bookmark3")!,
    );
    const bookmark4Changes = result.bookmarkedChangeIdToSegment.get(
      result.bookmarkToChangeId.get("bookmark4")!,
    );
    const bookmark5Changes = result.bookmarkedChangeIdToSegment.get(
      result.bookmarkToChangeId.get("bookmark5")!,
    );
    const bookmark6Changes = result.bookmarkedChangeIdToSegment.get(
      result.bookmarkToChangeId.get("bookmark6")!,
    );

    assert.ok(
      bookmark1Changes &&
        bookmark1Changes.length === 1 &&
        bookmark1Changes[0].changeId === "change_b",
      `Expected bookmark1 segmentChanges to contain only change_b`,
    );
    assert.ok(
      bookmark2Changes &&
        bookmark2Changes.length === 1 &&
        bookmark2Changes[0].changeId === "change_c",
      `Expected bookmark2 segmentChanges to contain only change_c`,
    );
    assert.ok(
      bookmark3Changes &&
        bookmark3Changes.length === 1 &&
        bookmark3Changes[0].changeId === "change_d",
      `Expected bookmark3 segmentChanges to contain only change_d`,
    );
    assert.ok(
      bookmark4Changes &&
        bookmark4Changes.length === 1 &&
        bookmark4Changes[0].changeId === "change_e",
      `Expected bookmark4 segmentChanges to contain only change_e`,
    );
    assert.ok(
      bookmark5Changes &&
        bookmark5Changes.length === 1 &&
        bookmark5Changes[0].changeId === "change_f",
      `Expected bookmark5 segmentChanges to contain only change_f`,
    );
    assert.ok(
      bookmark6Changes &&
        bookmark6Changes.length === 1 &&
        bookmark6Changes[0].changeId === "change_g",
      `Expected bookmark6 segmentChanges to contain only change_g`,
    );
  });
});

suite("remote validation", () => {
  test("isGitHubRemote detects GitHub HTTPS URLs", () => {
    assert.ok(isGitHubRemote("https://github.com/owner/repo.git"));
    assert.ok(isGitHubRemote("https://github.com/owner/repo"));
    assert.ok(isGitHubRemote("https://github.com/owner/repo-name.git"));
  });

  test("isGitHubRemote detects GitHub SSH URLs", () => {
    assert.ok(isGitHubRemote("git@github.com:owner/repo.git"));
    assert.ok(isGitHubRemote("git@github.com:owner/repo"));
    assert.ok(isGitHubRemote("git@github.com:owner/repo-name.git"));
  });

  test("isGitHubRemote detects GitHub subdomain URLs", () => {
    assert.ok(isGitHubRemote("https://company.github.com/owner/repo.git"));
    assert.ok(isGitHubRemote("git@company.github.com:owner/repo.git"));
  });

  test("isGitHubRemote rejects non-GitHub URLs", () => {
    assert.ok(!isGitHubRemote("https://gitlab.com/owner/repo.git"));
    assert.ok(!isGitHubRemote("https://bitbucket.org/owner/repo.git"));
    assert.ok(!isGitHubRemote("git@gitlab.com:owner/repo.git"));
    assert.ok(!isGitHubRemote(""));
    assert.ok(!isGitHubRemote("invalid-url"));
  });

  test("filterGitHubRemotes filters correctly", () => {
    const remotes = [
      { name: "origin", url: "https://github.com/owner/repo.git" },
      { name: "upstream", url: "git@github.com:upstream/repo.git" },
      { name: "gitlab", url: "https://gitlab.com/owner/repo.git" },
      { name: "bitbucket", url: "https://bitbucket.org/owner/repo.git" },
      { name: "enterprise", url: "https://company.github.com/owner/repo.git" },
    ];

    const githubRemotes = filterGitHubRemotes(remotes);

    assert.equal(githubRemotes.length, 3);
    assert.equal(githubRemotes[0].name, "origin");
    assert.equal(githubRemotes[1].name, "upstream");
    assert.equal(githubRemotes[2].name, "enterprise");
  });

  test("filterGitHubRemotes handles empty list", () => {
    const githubRemotes = filterGitHubRemotes([]);
    assert.equal(githubRemotes.length, 0);
  });

  test("filterGitHubRemotes handles no GitHub remotes", () => {
    const remotes = [
      { name: "gitlab", url: "https://gitlab.com/owner/repo.git" },
      { name: "bitbucket", url: "https://bitbucket.org/owner/repo.git" },
    ];

    const githubRemotes = filterGitHubRemotes(remotes);
    assert.equal(githubRemotes.length, 0);
  });
});
