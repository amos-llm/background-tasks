import { basename } from "node:path";

type Token = { kind: "word" | "operator" | "redirect"; value: string };
const outputFilters = new Set(["grep", "egrep", "fgrep", "rg", "head", "tail", "sed", "awk"]);

// This is a guard against common log-truncation mistakes, not a shell parser or
// security boundary. Keep quoted arguments, comments and heredoc data out of
// pipeline detection. Never rewrite a command: doing so can change its meaning.
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let position = 0, heredoc: boolean | undefined;
  while (position < command.length) {
    const char = command[position];
    if (char === "\\" && command[position + 1] === "\n") { position += 2; continue; }
    if (char === "\n") {
      tokens.push({ kind: "operator", value: "\n" }); position++;
      for (const doc of heredocs.splice(0)) {
        while (position < command.length) {
          const end = command.indexOf("\n", position);
          const line = command.slice(position, end < 0 ? command.length : end);
          position = end < 0 ? command.length : end + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
        }
      }
      continue;
    }
    if (/\s/.test(char)) { position++; continue; }
    if (char === "#") {
      const end = command.indexOf("\n", position);
      position = end < 0 ? command.length : end; continue;
    }
    const redirect = command.slice(position).match(/^(?:\d+)?(?:<<<|<<-|<<|>>|>&|<&|<>|>\||>|<)/)?.[0];
    if (redirect) {
      tokens.push({ kind: "redirect", value: redirect }); position += redirect.length;
      const operator = redirect.replace(/^\d+/, "");
      if (operator === "<<-") heredoc = true;
      else if (operator === "<<") heredoc = false;
      continue;
    }
    const operator = command.slice(position).match(/^(?:\|\||\|&|&&|[|&;(){}])/)?.[0];
    if (operator) {
      tokens.push({ kind: "operator", value: operator }); position += operator.length; continue;
    }
    let value = "";
    while (position < command.length && !/[\s|&;(){}<>]/.test(command[position])) {
      const next = command[position++];
      if (next === "\\") {
        const escaped = command[position++];
        if (escaped && escaped !== "\n") value += escaped;
      } else if (next === "'" || next === '"' || next === "`") {
        while (position < command.length && command[position] !== next) {
          const quoted = command[position++];
          if (next !== "'" && quoted === "\\" && position < command.length) {
            const escaped = command[position++];
            if (escaped !== "\n") value += next === '"' && !/[\$`"\\]/.test(escaped) ? `\\${escaped}` : escaped;
          } else value += quoted;
        }
        if (command[position] === next) position++;
      } else value += next;
    }
    tokens.push({ kind: "word", value });
    if (heredoc !== undefined) {
      heredocs.push({ delimiter: value, stripTabs: heredoc }); heredoc = undefined;
    }
  }
  return tokens;
}

function commandAt(tokens: Token[], start: number) {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind === "redirect") { index += 2; continue; }
    if (token.kind === "operator") {
      if (["\n", "(", "{"].includes(token.value)) { index++; continue; }
      return;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) { index++; continue; }
    const name = basename(token.value);
    if (["env", "command", "exec", "stdbuf"].includes(name)) {
      index++;
      // Common wrappers use attached options, e.g. stdbuf -oL or env -i.
      while (tokens[index]?.kind === "word" && tokens[index].value.startsWith("-")) {
        const option = tokens[index++].value;
        if (name === "command" && ["-v", "-V"].includes(option)) return;
        if (name === "stdbuf" && /^-[ioe]$/.test(option)) index++;
        if (name === "env" && ["-u", "--unset", "-C", "--chdir"].includes(option)) index++;
      }
      continue;
    }
    return { name, index };
  }
}

export function assertUnfilteredTaskCommand(command: string, depth = 0): void {
  const tokens = tokenize(command);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== "operator" || !["|", "|&"].includes(token.value)) continue;
    const target = commandAt(tokens, index + 1);
    if (target && outputFilters.has(target.name)) {
      throw new Error(`task_start rejected an output-filtering pipeline (| ${target.name}): it would discard or buffer live logs before capture. Retry task_start with the original foreground command, without the output filter. Use task_logs with tailLines/filter/before to limit only the agent's view; the user must retain the full live log. Do not switch to another shell tool. The command was not started or modified.`);
    }
  }
  // Recognize common quoted shell wrappers without treating arbitrary quoted
  // program arguments (node -e, printf, etc.) as shell commands.
  if (depth >= 8) return;
  for (let index = 0; index < tokens.length; index++) {
    if (index > 0 && (tokens[index - 1].kind !== "operator" || ![";", "\n", "&&", "||", "|", "|&", "(", "{"].includes(tokens[index - 1].value))) continue;
    const target = commandAt(tokens, index);
    if (!target || !["bash", "sh", "dash", "zsh", "ksh"].includes(target.name)) continue;
    let argument = target.index + 1;
    while (tokens[argument]?.kind === "word" && tokens[argument].value.startsWith("-")) {
      const option = tokens[argument++].value;
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(option)) {
        if (tokens[argument]?.kind === "word") assertUnfilteredTaskCommand(tokens[argument].value, depth + 1);
        break;
      }
    }
  }
}
