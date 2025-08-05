import { Octokit } from "octokit";
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGitHubAuth } from "./auth.js";
import type {
  Bookmark,
  ChangeGraph,
  BookmarkSegment,
  NarrowedBookmarkSegment,
} from "./jjTypes.js";
import type { JjFunctions } from "./jjUtils.js";
import { isGitHubRemote } from "./jjUtils.js";
import * as v from "valibot";

export type PullRequest = PullRequestItem | PullRequestListItem;
type PullRequestItem = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["get"]>
>["data"];
type PullRequestListItem = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["list"]>
>["data"][0];

export interface GitHubConfig {
  owner: string;
  repo: string;
  octokit: Octokit;
}

// AIDEV-NOTE: Types for three-phase submission approach

// Phase 1: Change graph analysis result
export interface SubmissionAnalysis {
  targetBookmark: string;
  changeGraph: ChangeGraph;
  relevantSegments: BookmarkSegment[];
}

// Phase 2: Plan creation callbacks (simplified, no bookmark selection)
export interface PlanCallbacks {
  onCheckingPRs?: (bookmarks: Bookmark[]) => void;
  onPlanReady?: (plan: SubmissionPlan) => void;
  onError?: (error: Error, context: string) => void;
}

const PRCommentDataSchema = v.object({
  version: v.number(),
  stack: v.array(
    v.object({
      bookmarkName: v.string(),
      prUrl: v.pipe(v.string(), v.url()),
      prNumber: v.number(),
    }),
  ),
});
type PRCommentData = v.InferOutput<typeof PRCommentDataSchema>;

export interface SubmissionPlan {
  targetBookmark: string;
  bookmarksToSubmit: Bookmark[]; // AIDEV-NOTE: Now guaranteed to be exactly one per segment
  bookmarksNeedingPush: Bookmark[];
  bookmarksNeedingPR: {
    bookmark: Bookmark;
    baseBranchOptions: string[];
    prContent: { title: string, body?: string };
  }[];
  bookmarksNeedingPRBaseUpdate: {
    bookmark: Bookmark;
    currentBaseBranch: string;
    expectedBaseBranchOptions: string[];
    pr: PullRequest;
  }[];
  repoInfo: { owner: string; repo: string };
  existingPRs: Map<string, PullRequest>;
  remoteName: string;
}

// Phase 3: Execution callbacks (unchanged from before)
export interface ExecutionCallbacks {
  onPushStarted?: (bookmark: Bookmark, remote: string) => void;
  onPushCompleted?: (bookmark: Bookmark, remote: string) => void;
  onPRStarted?: (bookmark: Bookmark, title: string, base: string) => void;
  onPRCompleted?: (bookmark: Bookmark, pr: PullRequest) => void;
  onPRBaseUpdateStarted?: (
    bookmark: Bookmark,
    currentBase: string,
    newBase: string,
  ) => void;
  onPRBaseUpdateCompleted?: (bookmark: Bookmark, pr: PullRequest) => void;
  onError?: (error: Error, context: string) => void;
}

export interface SubmissionResult {
  success: boolean;
  pushedBookmarks: Bookmark[];
  createdPRs: Array<{ bookmark: Bookmark; pr: PullRequest }>;
  updatedPRs: Array<{ bookmark: Bookmark; pr: PullRequest }>;
  errors: Array<{ error: Error; context: string }>;
}

/**
 * PHASE 1: Analyze the change graph for submission
 * AIDEV-NOTE: Pure analysis function - no bookmark selection, just identifies what needs to be resolved
 */
export function analyzeSubmissionGraph(
  changeGraph: ChangeGraph,
  bookmarkName: string,
): SubmissionAnalysis {
  // Find which stack contains the target bookmark
  for (const stack of changeGraph.stacks) {
    const targetIndex = stack.segments.findIndex((segment) =>
      segment.bookmarks.map((b) => b.name).includes(bookmarkName),
    );

    if (targetIndex !== -1) {
      const relevantSegments = stack.segments.slice(0, targetIndex + 1);

      return {
        targetBookmark: bookmarkName,
        changeGraph,
        relevantSegments,
      };
    }
  }

  throw new Error(`Bookmark '${bookmarkName}' not found in any stack`);
}

/**
 * Extract GitHub owner and repo from jj git remote URL
 */
export async function getGitHubRepoInfo(
  jj: JjFunctions,
  remoteName: string,
): Promise<{
  owner: string;
  repo: string;
}> {
  // Get the specified remote URL using JJ
  const remotes = await jj.getGitRemoteList();

  // Find the specified remote
  const targetRemote = remotes.find((remote) => remote.name === remoteName);
  if (!targetRemote) {
    throw new Error(`No '${remoteName}' remote found`);
  }

  const remoteUrl = targetRemote.url;

  // Validate that this is a GitHub remote
  if (!isGitHubRemote(remoteUrl)) {
    throw new Error(
      `Remote '${remoteName}' does not point to GitHub.com: ${remoteUrl}`,
    );
  }

  // Parse GitHub URLs - support both HTTPS and SSH formats
  // HTTPS: https://github.com/owner/repo.git
  // SSH: git@github.com:owner/repo.git
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);

  if (!match) {
    throw new Error(
      `Could not parse GitHub repository from remote URL: ${remoteUrl}`,
    );
  }

  const owner = match[1];
  let repo = match[2];

  // Remove .git suffix if present
  if (repo.endsWith(".git")) {
    repo = repo.slice(0, -4);
  }

  return { owner, repo };
}

/**
 * Get the GitHub configuration from environment or config
 */
export async function getGitHubConfig(
  jj: JjFunctions,
  remoteName: string,
): Promise<GitHubConfig> {
  // Get authentication using the auth utility
  const authResult = await getGitHubAuth();
  if (authResult.kind !== "success") {
    throw new Error(`GitHub authentication failed: ${authResult.reason}`);
  }
  const octokit = new Octokit({ auth: authResult.config.token });

  // Try to extract owner/repo from git remote, fall back to environment variables
  let owner = process.env.GITHUB_OWNER;
  let repo = process.env.GITHUB_REPO;

  if (!owner || !repo) {
    const repoInfo = await getGitHubRepoInfo(jj, remoteName);
    owner = repoInfo.owner;
    repo = repoInfo.repo;
  }

  return { owner, repo, octokit };
}

/**
 * Check if a PR already exists for the given branch
 */
export async function findExistingPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  headBranch: string,
): Promise<PullRequestListItem | null> {
  const result = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${headBranch}`,
    state: "open",
  });

  const pulls = result.data;
  return pulls.length > 0 ? pulls[0] : null;
}

/**
 * Get the base branch for a bookmark based on what it's stacked on
 */
export function getBaseBranchOptions(
  bookmarkName: string,
  segments: NarrowedBookmarkSegment[],
  defaultBranch: string,
): string[] {
  // Find the bookmark in the segments array
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.bookmark.name === bookmarkName) {
      // If this is the first segment in the stack, it's based on the default branch
      if (i === 0) {
        return [defaultBranch];
      }

      // Otherwise, it's based on the previous segment's bookmark
      const previousSegment = segments[i - 1];
      return [previousSegment.bookmark.name];
    }
  }

  throw new Error(
    `Bookmark '${bookmarkName}' not found in any segment to determine base branch`,
  );
}

/**
 * Generate PR title from the bookmark's commits
 */
export function generatePRTitle(
  bookmarkName: string,
  segments: NarrowedBookmarkSegment[],
): string {
  // Find the segment containing this bookmark
  const segment = segments.find((s) => s.bookmark.name === bookmarkName);
  if (!segment) {
    throw new Error(`Segment not found for bookmark ${bookmarkName}`);
  }

  if (segment.changes.length === 0) {
    throw new Error(`No changes found for bookmark ${bookmarkName}`);
  }

  // Use the latest commit's description as the title
  return segment.changes[0].descriptionFirstLine || bookmarkName;
}


/**
 * Grab the provided template
 */
export function getTemplate(root: string, template: string): string | undefined {
  try {
    return fs.readFileSync(path.join(root, template), {encoding: "utf8"});
  } catch (e) {
    return undefined;
  }
}

/**
 * Create a new PR
 */
export async function createPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  bookmarkName: string,
  baseBranch: string,
  title: string,
  body?: string,
): Promise<PullRequestItem> {
  const result = await octokit.rest.pulls.create({
    owner,
    repo,
    title,
    body,
    head: bookmarkName,
    base: baseBranch,
  });

  return result.data;
}

/**
 * Update the base branch of an existing PR
 */
export async function updatePRBase(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  newBaseBranch: string,
): Promise<PullRequestItem> {
  const result = await octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    base: newBaseBranch,
  });

  return result.data;
}

const commentDataPrefix = "<!--- JJ-STACK_INFO: ";
const commentDataPostfix = " --->";
const stackCommentFooter =
  "*Created with [jj-stack](https://github.com/keanemind/jj-stack)*";
const stackCommentThisPRText = "← this PR";

/**
 * Create or update a stack information comment on a PR
 */
export async function createOrUpdateStackComment(
  githubConfig: GitHubConfig,
  prCommentData: PRCommentData,
  currentBookmarkIdx: number,
): Promise<void> {
  const encodedPRCommentData = Buffer.from(
    JSON.stringify(prCommentData),
  ).toString("base64");
  let commentBody = `${commentDataPrefix}${encodedPRCommentData}${commentDataPostfix}\nThis PR is part of a stack of ${prCommentData.stack.length} bookmark${prCommentData.stack.length === 1 ? "" : "s"}:\n\n`;

  commentBody += `1. \`trunk()\`\n`;
  for (let i = 0; i < prCommentData.stack.length; i++) {
    const stackItem = prCommentData.stack[i];
    const isCurrent = i === currentBookmarkIdx;
    if (isCurrent) {
      commentBody += `1. **${stackItem.bookmarkName} ${stackCommentThisPRText}**\n`;
    } else {
      commentBody += `1. [${stackItem.bookmarkName}](${stackItem.prUrl})\n`;
    }
  }

  commentBody += `\n---\n${stackCommentFooter}`;

  const currentPRnumber = prCommentData.stack[currentBookmarkIdx].prNumber;

  // List existing comments to find our stack comment
  const comments = await githubConfig.octokit.rest.issues.listComments({
    owner: githubConfig.owner,
    repo: githubConfig.repo,
    issue_number: currentPRnumber,
  });

  // Find existing jj-stack comment by looking for our footer
  const existingComment = comments.data.find((comment) =>
    comment.body?.includes(stackCommentFooter),
  );

  if (existingComment) {
    // Update existing comment
    await githubConfig.octokit.rest.issues.updateComment({
      owner: githubConfig.owner,
      repo: githubConfig.repo,
      comment_id: existingComment.id,
      body: commentBody,
    });
  } else {
    // Create new comment
    await githubConfig.octokit.rest.issues.createComment({
      owner: githubConfig.owner,
      repo: githubConfig.repo,
      issue_number: currentPRnumber,
      body: commentBody,
    });
  }
}

async function findCommentData(
  githubConfig: GitHubConfig,
  prNumber: number,
): Promise<PRCommentData | undefined> {
  const comments = await githubConfig.octokit.rest.issues.listComments({
    owner: githubConfig.owner,
    repo: githubConfig.repo,
    issue_number: prNumber,
  });

  const comment = comments.data.find((comment) =>
    comment.body?.includes(stackCommentFooter),
  );

  if (comment?.body) {
    const lines = comment.body.trim().split("\n");
    if (
      lines[0] &&
      lines[0].includes(commentDataPrefix) &&
      lines[0].includes(commentDataPostfix)
    ) {
      const rawData = lines[0].slice(
        commentDataPrefix.length,
        -commentDataPostfix.length,
      );
      const decoded = Buffer.from(rawData, "base64").toString();
      try {
        const parsedJson = JSON.parse(decoded) as unknown;
        return v.parse(PRCommentDataSchema, parsedJson);
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

/**
 * Check for existing PRs for all bookmarks
 */
export async function getExistingPRs(
  octokit: Octokit,
  owner: string,
  repo: string,
  bookmarks: Bookmark[],
): Promise<Map<string, PullRequestListItem>> {
  const results = new Map<string, PullRequestListItem>();

  for (const bookmark of bookmarks) {
    const existingPR = await findExistingPR(
      octokit,
      owner,
      repo,
      bookmark.name,
    );
    if (existingPR) {
      results.set(bookmark.name, existingPR);
    }
  }

  return results;
}

/**
 * Validate existing PRs against expected base branches and identify mismatches
 */
export function validatePRBases(
  bookmarks: Bookmark[],
  existingPRs: Map<string, PullRequestListItem | null>,
  segments: NarrowedBookmarkSegment[],
  defaultBranch: string,
): {
  bookmark: Bookmark;
  currentBaseBranch: string;
  expectedBaseBranchOptions: string[];
  pr: PullRequestListItem;
}[] {
  const mismatches: {
    bookmark: Bookmark;
    currentBaseBranch: string;
    expectedBaseBranchOptions: string[];
    pr: PullRequestListItem;
  }[] = [];

  for (const bookmark of bookmarks) {
    const existingPR = existingPRs.get(bookmark.name);

    if (existingPR) {
      const expectedBaseBranchOptions = getBaseBranchOptions(
        bookmark.name,
        segments,
        defaultBranch,
      );
      const currentBaseBranch = existingPR.base.ref;

      if (!expectedBaseBranchOptions.includes(currentBaseBranch)) {
        mismatches.push({
          bookmark,
          currentBaseBranch,
          expectedBaseBranchOptions,
          pr: existingPR,
        });
      }
    }
  }

  return mismatches;
}

/**
 * PHASE 2: Create submission plan from resolved bookmarks
 * AIDEV-NOTE: Takes exactly one bookmark per segment (enforced by CLI)
 */
export async function createSubmissionPlan(
  jj: JjFunctions,
  githubConfig: GitHubConfig,
  segments: NarrowedBookmarkSegment[],
  remoteName: string,
  callbacks?: PlanCallbacks,
  template?: string,
): Promise<SubmissionPlan> {
  try {
    const bookmarksToSubmit = segments.map((s) => s.bookmark);
    const targetBookmark = bookmarksToSubmit[bookmarksToSubmit.length - 1].name;
    const root = await jj.getRoot();

    callbacks?.onCheckingPRs?.(bookmarksToSubmit);
    const existingPRs = await getExistingPRs(
      githubConfig.octokit,
      githubConfig.owner,
      githubConfig.repo,
      bookmarksToSubmit,
    );

    const defaultBranch = await jj.getDefaultBranch();

    // Validate existing PRs against expected base branches
    const bookmarksNeedingPRBaseUpdate = validatePRBases(
      bookmarksToSubmit,
      existingPRs,
      segments,
      defaultBranch,
    );

    // Load the PR template, if any
    let body: string | undefined;
    if (template != null) {
      body = getTemplate(root, template);
    }


    // Determine what actions are needed
    const bookmarksNeedingPush: Bookmark[] = [];
    const bookmarksNeedingPR: SubmissionPlan["bookmarksNeedingPR"] = [];

    for (const bookmark of bookmarksToSubmit) {
      const hasExistingPR = existingPRs.get(bookmark.name);

      if (!bookmark.hasRemote || !bookmark.isSynced) {
        bookmarksNeedingPush.push(bookmark);
      }

      if (!hasExistingPR) {
        bookmarksNeedingPR.push({
          bookmark,
          baseBranchOptions: getBaseBranchOptions(
            bookmark.name,
            segments,
            defaultBranch,
          ),
          prContent: { title: generatePRTitle(bookmark.name, segments), body },
        });
      }
    }

    const plan: SubmissionPlan = {
      targetBookmark,
      bookmarksToSubmit,
      bookmarksNeedingPush,
      bookmarksNeedingPR,
      bookmarksNeedingPRBaseUpdate,
      repoInfo: {
        owner: githubConfig.owner,
        repo: githubConfig.repo,
      },
      existingPRs,
      remoteName,
    };

    callbacks?.onPlanReady?.(plan);
    return plan;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    callbacks?.onError?.(err, "planning");
    throw err;
  }
}

/**
 * PHASE 3: Execute the submission plan
 * AIDEV-NOTE: Pure execution of the plan with no decision-making
 */
export async function executeSubmissionPlan(
  jj: JjFunctions,
  plan: SubmissionPlan,
  githubConfig: GitHubConfig,
  callbacks?: ExecutionCallbacks,
): Promise<SubmissionResult> {
  const result: SubmissionResult = {
    success: true,
    pushedBookmarks: [],
    createdPRs: [],
    updatedPRs: [],
    errors: [],
  };

  try {
    // Push all bookmarks that need pushing
    for (const bookmark of plan.bookmarksNeedingPush) {
      try {
        callbacks?.onPushStarted?.(bookmark, plan.remoteName);
        await jj.pushBookmark(bookmark.name, plan.remoteName);
        callbacks?.onPushCompleted?.(bookmark, plan.remoteName);
        result.pushedBookmarks.push(bookmark);
      } catch (error) {
        throw new Error(`Error pushing ${bookmark.name}: ${String(error)}`);
      }
    }

    const bookmarkToPR = new Map<string, PullRequest>(plan.existingPRs);

    // Update PR bases for existing PRs that need it (in order from bottom to top)
    for (const {
      bookmark,
      currentBaseBranch,
      expectedBaseBranchOptions,
      pr,
    } of plan.bookmarksNeedingPRBaseUpdate) {
      try {
        if (expectedBaseBranchOptions.length !== 1) {
          throw new Error(
            `Expected exactly one base branch option for ${bookmark.name}, but got ${expectedBaseBranchOptions.length}`,
          );
        }

        callbacks?.onPRBaseUpdateStarted?.(
          bookmark,
          currentBaseBranch,
          expectedBaseBranchOptions[0],
        );

        const updatedPR = await updatePRBase(
          githubConfig.octokit,
          githubConfig.owner,
          githubConfig.repo,
          pr.number,
          expectedBaseBranchOptions[0],
        );

        callbacks?.onPRBaseUpdateCompleted?.(bookmark, updatedPR);
        result.updatedPRs.push({ bookmark, pr: updatedPR });
      } catch (error) {
        throw new Error(
          `Error updating PR base for ${bookmark.name}: ${String(error)}`,
        );
      }
    }

    // Then create PRs for bookmarks that need them (in order from bottom to top)
    for (const {
      bookmark,
      baseBranchOptions,
      prContent,
    } of plan.bookmarksNeedingPR) {
      try {
        if (baseBranchOptions.length !== 1) {
          throw new Error(
            `Expected exactly one base branch option for ${bookmark.name}, but got ${baseBranchOptions.length}`,
          );
        }

        callbacks?.onPRStarted?.(
          bookmark,
          prContent.title,
          baseBranchOptions[0],
        );

        const pr = await createPR(
          githubConfig.octokit,
          githubConfig.owner,
          githubConfig.repo,
          bookmark.name,
          baseBranchOptions[0],
          prContent.title,
          prContent.body,
        );

        callbacks?.onPRCompleted?.(bookmark, pr);
        result.createdPRs.push({ bookmark, pr });
        bookmarkToPR.set(bookmark.name, pr);
      } catch (error) {
        throw new Error(
          `Error creating PR for ${bookmark.name}: ${String(error)}`,
        );
      }
    }

    // Create/update stack comments for all PRs
    if (bookmarkToPR.size > 0) {
      const rootBookmark = plan.bookmarksToSubmit[0];
      const rootPR = bookmarkToPR.get(rootBookmark.name);
      if (!rootPR) {
        throw new Error(
          "PR not found in bookmarkToPr for bookmark in bookmarksToSubmit",
        );
      }

      const alreadyMergedStack = await (async () => {
        const rootPRCommentData = await findCommentData(
          githubConfig,
          rootPR.number,
        );
        if (rootPRCommentData === undefined) {
          return [];
        }

        const rootPRIdx = rootPRCommentData.stack.findIndex(
          (item) => item.prNumber === rootPR.number,
        );
        // If the root PR is not found or is the first in the stack, no already-merged parent
        if (rootPRIdx <= 0) {
          return [];
        }

        const rootParentPRInfo = rootPRCommentData.stack[rootPRIdx - 1];

        const rootParentPR = (
          await githubConfig.octokit.rest.pulls.get({
            owner: githubConfig.owner,
            repo: githubConfig.repo,
            pull_number: rootParentPRInfo.prNumber,
          })
        ).data;

        if (!rootParentPR.merged) {
          return [];
        }

        return rootPRCommentData.stack.slice(0, rootPRIdx);
      })();

      const prCommentData = {
        version: 0,
        stack: [
          ...alreadyMergedStack,
          ...plan.bookmarksToSubmit.map((bookmark) => {
            const pr = bookmarkToPR.get(bookmark.name);
            if (!pr) {
              throw new Error(
                "PR not found in bookmarkToPr for bookmark in bookmarksToSubmit",
              );
            }
            return {
              bookmarkName: bookmark.name,
              prUrl: pr.html_url,
              prNumber: pr.number,
            };
          }),
        ],
      } satisfies PRCommentData;

      for (let i = 0; i < prCommentData.stack.length; i++) {
        const stackItem = prCommentData.stack[i];
        try {
          await createOrUpdateStackComment(githubConfig, prCommentData, i);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          result.errors.push({
            error: err,
            context: `creating/updating stack comment for ${stackItem.bookmarkName}`,
          });
          callbacks?.onError?.(
            err,
            `creating/updating stack comment for ${stackItem.bookmarkName}`,
          );
          // Don't mark as failed for comment errors
        }
      }
    }

    return result;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    result.errors.push({ error: err, context: "execution" });
    callbacks?.onError?.(err, "execution");
    result.success = false;
    return result;
  }
}

/**
 * Convert resolved bookmarks and analysis into narrowed bookmark segments
 * AIDEV-NOTE: Helper function to bridge between CLI bookmark selection and submission planning
 */
export function createNarrowedSegments(
  resolvedBookmarks: Bookmark[],
  analysis: SubmissionAnalysis,
): NarrowedBookmarkSegment[] {
  const segments: NarrowedBookmarkSegment[] = [];

  for (let i = 0; i < resolvedBookmarks.length; i++) {
    const bookmark = resolvedBookmarks[i];
    const correspondingSegment = analysis.relevantSegments[i];

    if (!correspondingSegment) {
      throw new Error(
        `No segment found for bookmark ${bookmark.name} at index ${i}`,
      );
    }

    segments.push({
      bookmark,
      changes: correspondingSegment.changes,
    });
  }

  return segments;
}
