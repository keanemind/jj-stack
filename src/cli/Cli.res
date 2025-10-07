@scope("process") @val external argv: array<string> = "argv"
@scope("process") @val external exit: int => unit = "exit"

// AIDEV-NOTE: Main CLI entry point implementing all jj-stack commands:
// - Default (no args): Interactive change graph analysis and stack selection
// - submit <bookmark> [--dry-run]: Submit bookmark stack as PRs
// - auth test: Validate GitHub authentication setup
// - auth help: Show authentication setup instructions
// - help/--help/-h: Display command usage information

// AIDEV-NOTE: Central jjFunctions initialization for dependency injection pattern
@module("../lib/jjUtils.js")
external createJjFunctions: JJTypes.jjConfig => JJTypes.jjFunctions = "createJjFunctions"
@module("../lib/jjUtils.js")
external isGitHubRemote: string => bool = "isGitHubRemote"

@unboxed type argumentValue = String(string) | Boolean(bool)

type parseArgsResult = {"values": Js.Dict.t<argumentValue>, "positionals": array<string>}

@module("node:util")
external parseArgs: Js.t<{..}> => parseArgsResult = "parseArgs"

let help = `🔧 jj-stack - Jujutsu Git workflow automation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

USAGE:
  jj-stack [COMMAND] [OPTIONS]

COMMANDS:
  submit <bookmark>     Submit a bookmark and all downstack bookmarks as PRs
    --dry-run           Show what would be done without making changes
    --remote <name>     Use the specified Git remote (must be a GitHub remote)
    --template <name>   Use the specified PR submission template

  auth test             Test GitHub authentication
  auth help             Show authentication help

  help, --help, -h      Show this help message

DEFAULT BEHAVIOR:
  Running jj-stack without arguments analyzes and displays the current
  graph of stacked bookmarks.

EXAMPLES:
  jj-stack                        # Show change graph
  jj-stack submit feature-branch  # Submit feature-branch and downstack as PRs
  jj-stack submit feature-branch --dry-run  # Preview what would be done
  jj-stack submit feature-branch --remote upstream  # Use a specific remote
  jj-stack auth test              # Test GitHub authentication

For more information, visit: https://github.com/keanemind/jj-stack
`

// AIDEV-NOTE: Phase 5 - Async remote resolution with interactive selection for multiple GitHub remotes
let resolveRemoteName = async (
  remotes: array<JJTypes.gitRemote>,
  userSpecified: option<string>,
): string => {
  switch userSpecified {
  | Some(remoteName) => {
      let foundRemote = remotes->Array.find(r => r.name == remoteName)
      switch foundRemote {
      | Some(remote) => {
          if !isGitHubRemote(remote.url) {
            Console.error(
              `❌ Remote '${remoteName}' is not a GitHub remote. Only GitHub remotes are supported.`,
            )
            exit(1)
            Js.Exn.raiseError("") // unreachable
          }
          remoteName
        }
      | None => {
          Console.error(`❌ Remote '${remoteName}' does not exist.`)
          exit(1)
          Js.Exn.raiseError("")
        }
      }
    }
  | None => {
      let githubRemotes = remotes->Array.filter(r => isGitHubRemote(r.url))
      switch githubRemotes->Array.length {
      | 0 => {
          Console.error("❌ No GitHub remotes found. At least one GitHub remote is required.")
          exit(1)
          Js.Exn.raiseError("")
        }
      | 1 => Belt.Array.getExn(githubRemotes, 0).name
      | _ => {
          // AIDEV-NOTE: Multiple GitHub remotes - use interactive selection
          Console.log(`🔀 Multiple GitHub remotes found, opening interactive selector...`)
          Console.log() // add space before the component

          await Promise.make((resolve, _reject) => {
            let inkInstanceRef: ref<option<InkBindings.inkInstance>> = ref(None)

            let component =
              <RemoteSelectionComponent
                remotes={githubRemotes}
                onComplete={selectedRemoteName => {
                  // Clean up the component first
                  switch inkInstanceRef.contents {
                  | Some(instance) => instance.unmount()
                  | None => ()
                  }
                  resolve(selectedRemoteName)
                }}
              />

            let inkInstance = InkBindings.render(component)
            inkInstanceRef := Some(inkInstance)
          })
        }
      }
    }
  }
}

@genType
let main = async () => {
  try {
    // AIDEV-NOTE: Initialize JJ functions once during CLI startup for efficiency
    let jjPathResult = await Utils.getJJPath()
    let jjConfig: JJTypes.jjConfig = {
      binaryPath: jjPathResult.filepath,
    }
    let jjFunctions = createJjFunctions(jjConfig)

    let parsed = parseArgs({
      "options": {
        "remote": {"type": "string"},
        "dry-run": {"type": "boolean", "default": false},
        "template": {"type": "string"},
        "help": {"type": "boolean", "short": "h", "default": false},
      },
      "allowPositionals": true,
    })

    let positionals = parsed["positionals"]
    let command = Belt.Array.get(positionals, 0)
    let subArg = Belt.Array.get(positionals, 1)

    let remoteOpt = switch Js.Dict.get(parsed["values"], "remote") {
    | Some(remote) =>
      switch remote {
      | String(b) => Some(b)
      | _ => Exn.raiseError("--remote was used as a boolean")
      }
    | None => None
    }
    let isDryRun = switch Js.Dict.get(parsed["values"], "dry-run") {
    | Some(dryRun) =>
      switch dryRun {
      | Boolean(b) => b
      | _ => Exn.raiseError("--dry-run was used as a string")
      }
    | None => false
    }
    let templateOpt = switch Js.Dict.get(parsed["values"], "template") {
    | Some(template) =>
      switch template {
      | String(t) => Some(t)
      | _ => Exn.raiseError("--template was used as a boolean")
      }
    | None => None
    }
    let isHelp = switch Js.Dict.get(parsed["values"], "help") {
    | Some(help) =>
      switch help {
      | Boolean(b) => b
      | _ => Exn.raiseError("--help was used as a string")
      }
    | None => false
    }

    // AIDEV-NOTE: Always resolve remote name before command dispatch
    let remotes = await jjFunctions.getGitRemoteList()
    let remoteName = await resolveRemoteName(remotes, remoteOpt)

    switch command {
    | None =>
      if isHelp {
        Console.log(help)
      } else {
        await AnalyzeCommand.analyzeCommand(jjFunctions, ~remote=remoteName, ~dryRun=isDryRun, ~template=templateOpt)
      }
    | Some(cmd) =>
      switch cmd {
      | "auth" =>
        if isHelp {
          AuthCommand.authHelpCommand()
        } else {
          switch subArg {
          | Some("test") => await AuthCommand.authTestCommand()
          | _ => AuthCommand.authHelpCommand()
          }
        }
      | "submit" =>
        if isHelp {
          Console.error("Usage: jj-stack submit <bookmark-name> [--dry-run] [--remote <name>] [--template <name>]")
        } else {
          switch subArg {
          | Some(bookmarkName) =>
            await SubmitCommand.submitCommand(
              jjFunctions,
              bookmarkName,
              ~options={dryRun: isDryRun, remote: remoteName, template: templateOpt},
            )
          | None => {
              Console.error("Usage: jj-stack submit <bookmark-name> [--dry-run] [--remote <name>] [--template <name>]")
              exit(1)
            }
          }
        }
      | "help" => Console.log(help)
      | _ => {
          Console.error(`Unrecognized command: ${cmd}\n`)
          Console.log(help)
        }
      }
    }
  } catch {
  | Exn.Error(error) =>
    switch Exn.message(error) {
    | Some(message) => {
        Console.error("An error occurred: " ++ message)
        exit(1)
      }
    | None => {
        Console.error("An unknown error occurred.")
        exit(1)
      }
    }
  | _ => {
      Console.error("An unknown error occurred.")
      exit(1)
    }
  }
}
