"use strict";

// MCP prompts: ready-made starting points that an AI client shows as slash commands or a menu. A prompt is only a
// text for the AI, it does nothing by itself. Each one tells the AI which Superbase tools to use and in what order.

class PromptError extends Error {}

const clean = (value) => String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim().slice(0, 500);

const PROMPTS = [
  {
    name: "diagnose",
    title: "Diagnose the game",
    description: "Check the connection, read the errors and logs, and report what looks wrong in the running game.",
    arguments: [{ name: "focus", description: "Optional: what the user suspects, for example 'the shop does not open'.", required: false }],
    text: (args) =>
      [
        "Diagnose the Roblox game that is running right now.",
        args.focus ? `The user suspects: ${args.focus}` : "",
        "1. Call roblox_status and make sure a client is connected.",
        "2. Read get_errors and get_logs (newest first) and group the messages by cause. Ignore noise that repeats Roblox's own warnings.",
        "3. For each real problem, find the script that causes it with search_scripts or get_script_source, and explain the cause in plain words.",
        "4. Run stats if the problem sounds like lag or low FPS.",
        "Report what you found, ordered by importance, with the script paths. Do not change anything in the game unless the user asks for it.",
      ]
        .filter(Boolean)
        .join("\n"),
  },
  {
    name: "find-code",
    title: "Find code that does something",
    description: "Locate the scripts and lines that implement a feature, by meaning and by exact text.",
    arguments: [{ name: "what", description: "What the code does, for example 'gives coins when a part is touched'.", required: true }],
    text: (args) =>
      [
        `Find the code in this game that does the following: ${args.what}`,
        "1. If semantic_search has an index for this game, search by meaning first. Otherwise think of the words such code would contain and use search_scripts (words mode, then text mode).",
        "2. Read the best candidates with get_script_source and confirm that they really do it.",
        "3. Answer with the script paths and line numbers, and a short description of how the code works. If nothing matches, say what you tried.",
      ].join("\n"),
  },
  {
    name: "explain-game",
    title: "Explain how the game works",
    description: "Build an overview of the game's structure, scripts and remotes.",
    arguments: [],
    text: () =>
      [
        "Explain how this Roblox game is built.",
        "1. Call get_game_info for the overview, then get_hierarchy for the main services (Workspace, ReplicatedStorage, StarterGui, StarterPlayer).",
        "2. Call list_scripts and read the entry points: the scripts that are LocalScripts or that start with names like Main, Init or Client.",
        "3. List the RemoteEvents and RemoteFunctions with find_instances (class_name RemoteEvent, then RemoteFunction) and say what each one seems to be for.",
        "Finish with a short map: the main systems, how the client and the server talk to each other, and anything unusual. Keep it readable for someone who has never seen the game.",
      ].join("\n"),
  },
  {
    name: "trace-remote",
    title: "Trace remote calls",
    description: "Record the remote calls the game makes during an action and work out what they mean.",
    arguments: [{ name: "remote", description: "Optional: only look at remotes whose name contains this.", required: false }],
    text: (args) =>
      [
        "Trace the remote calls of the running game.",
        `1. Start remote_spy${args.remote ? ` with only set to "${args.remote}"` : ""}. Tell the user to do the action they are interested in (or use gui_interact if they asked you to).`,
        "2. Wait for them, then read the calls with remote_spy get and stop the spy.",
        "3. For each remote that was called, show the arguments and the calling script, find that script with get_script_source, and explain what the call does.",
        "Do not block remotes and do not fire them yourself unless the user asks for it.",
      ].join("\n"),
  },
  {
    name: "performance-check",
    title: "Check performance",
    description: "Measure FPS, stutters, memory and ping, and look for the scripts or instances that cause trouble.",
    arguments: [],
    text: () =>
      [
        "Check the performance of the running game.",
        "1. Call stats and note the average FPS, the 1% low, stutters, memory and ping.",
        "2. If something looks wrong, look for the cause: very large instance counts with get_game_info, loops that run every frame with search_scripts (Heartbeat, RenderStepped, while true do), and errors that repeat in get_logs.",
        "3. Report the numbers, the most likely causes with script paths, and what could be improved. Do not change the game unless the user asks for it.",
      ].join("\n"),
  },
  {
    name: "why-error",
    title: "Explain an error",
    description: "Find the cause of a script error, from the latest error or from the text you give.",
    arguments: [{ name: "error", description: "Optional: the error text. Without it the latest error of the game is used.", required: false }],
    text: (args) =>
      [
        args.error ? `Explain this error from the running game: ${args.error}` : "Explain the most recent script error of the running game.",
        "1. Use get_errors to see the error with its stack trace (skip this when the user gave the full text).",
        "2. Open the script and line that the error names with get_script_source, and read the code around it.",
        "3. Explain what goes wrong and why, and show the fix as a small code change. Do not apply it unless the user asks you to.",
      ].join("\n"),
  },
];

function list() {
  return PROMPTS.map(({ name, title, description, arguments: promptArguments }) => ({ name, title, description, arguments: promptArguments }));
}

// Returns { description, messages } for a prompt. Missing required arguments and unknown names raise PromptError.
function get(name, rawArgs) {
  const prompt = PROMPTS.find((candidate) => candidate.name === name);
  if (!prompt) throw new PromptError(`Unknown prompt: ${name}`);
  const given = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
  const args = {};
  for (const argument of prompt.arguments) {
    const value = clean(given[argument.name]);
    if (argument.required && value === "") throw new PromptError(`The prompt ${name} needs the argument '${argument.name}'.`);
    args[argument.name] = value;
  }
  return {
    description: prompt.description,
    messages: [{ role: "user", content: { type: "text", text: prompt.text(args) } }],
  };
}

module.exports = { list, get, PromptError, PROMPTS };
