interface Token {
  text: string;
  operator: boolean;
}

// A conservative command-input scanner, not a shell executor or a sandbox.
// Quoted/escaped operators are words. Substitutions are scanned independently.
export function shellMutation(command: string, depth = 0): boolean {
  if (depth > 8) return true;
  const tokens: Token[] = [];
  let word = "",
    quote = "",
    substitutionMutation = false;
  const flush = () => {
    if (word) tokens.push({ text: word, operator: false });
    word = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "\\" && quote !== "'") {
      word += command[++i] ?? "";
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = "";
      else word += c;
      continue;
    }
    if (c === "'" && !quote) {
      quote = "'";
      continue;
    }
    if (c === '"') {
      quote = quote === '"' ? "" : '"';
      continue;
    }
    if (c === "`" || (c === "$" && command[i + 1] === "(")) {
      const backtick = c === "`",
        start = i + (backtick ? 1 : 2);
      let end = start,
        nesting = 1,
        innerQuote = "";
      for (; end < command.length; end++) {
        const ch = command[end]!;
        if (ch === "\\") {
          end++;
          continue;
        }
        if (backtick) {
          if (ch === "`") break;
          continue;
        }
        if (ch === "'" || ch === '"') {
          if (innerQuote === ch) innerQuote = "";
          else if (!innerQuote) innerQuote = ch;
        }
        if (innerQuote) continue;
        if (ch === "(") nesting++;
        if (ch === ")" && --nesting === 0) break;
      }
      substitutionMutation ||= shellMutation(
        command.slice(start, end),
        depth + 1,
      );
      word += "$(substitution)";
      i = end;
      continue;
    }
    if (quote) {
      word += c;
      continue;
    }
    if (c === "#" && !word) {
      while (i < command.length && command[i] !== "\n") i++;
      flush();
      tokens.push({ text: ";", operator: true });
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      if (c === "\n") tokens.push({ text: ";", operator: true });
      continue;
    }
    const operator = [
      "&>>",
      "&>",
      ">>",
      ">&",
      "<&",
      "<>",
      "<<-",
      "<<<",
      "<<",
      "&&",
      "||",
      "|&",
      ";",
      "|",
      "&",
      ">",
      "<",
      "(",
      ")",
    ].find((v) => command.startsWith(v, i));
    if (operator) {
      flush();
      tokens.push({ text: operator, operator: true });
      i += operator.length - 1;
    } else word += c;
  }
  flush();
  if (substitutionMutation) return true;
  let segment: string[] = [];
  const mutatingSegment = (): boolean => {
    let words = segment;
    while (words.length) {
      const head = words[0]!.split(/[\\/]/).at(-1)!;
      if (
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) ||
        ["!", "if", "while", "until", "do", "then"].includes(head)
      ) {
        words = words.slice(1);
        continue;
      }
      if (!["env", "command", "exec", "sudo"].includes(head)) break;
      words = words.slice(1);
      while (words[0]?.startsWith("-")) {
        const option = words.shift()!;
        if (option === "--") break;
        if (head === "env" && ["-S", "--split-string"].includes(option)) {
          if (shellMutation(words.shift() ?? "", depth + 1)) return true;
        } else if (
          ["-u", "--user", "-g", "--group", "-C", "--chdir", "-a"].includes(
            option,
          )
        )
          words = words.slice(1);
      }
    }
    const binary = (words[0] ?? "").split(/[\\/]/).at(-1) ?? "";
    if (
      ["rm", "mv", "cp", "mkdir", "touch", "truncate", "install"].includes(
        binary,
      )
    )
      return true;
    if (
      binary === "tee" &&
      words.slice(1).some((w) => !w.startsWith("-") && w !== "/dev/null")
    )
      return true;
    if (
      ["sed", "perl"].includes(binary) &&
      words
        .slice(1)
        .some((w) => /^-[A-Za-z]*i/.test(w) || /^--in-place(?:=|$)/.test(w))
    )
      return true;
    if (
      /^(?:node|nodejs|bun|deno)$/.test(binary) &&
      words.some((w) => w === "-e" || w === "--eval" || w === "-p") &&
      /\b(?:writeFile|appendFile)(?:Sync)?(?:\s*\(|$)/.test(
        words.slice(1).join(" "),
      )
    )
      return true;
    return false;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.operator) {
      segment.push(token.text);
      continue;
    }
    if ([">", ">>", "&>", "&>>", "<>"].includes(token.text)) {
      const target = tokens[++i];
      if (!target || target.operator || target.text !== "/dev/null")
        return true;
      if (/^\d+$/.test(segment.at(-1) ?? "")) segment.pop();
    } else if ([">&", "<&", "<", "<<", "<<-", "<<<"].includes(token.text)) {
      const target = tokens[++i];
      if (
        token.text === ">&" &&
        target &&
        !/^\d+$|^-$/.test(target.text) &&
        target.text !== "/dev/null"
      )
        return true;
      if (/^\d+$/.test(segment.at(-1) ?? "")) segment.pop();
    } else {
      if (mutatingSegment()) return true;
      segment = [];
    }
  }
  return mutatingSegment();
}
