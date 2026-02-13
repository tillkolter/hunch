export type QueryCompileResult =
  | { ok: true; predicate: (message: string) => boolean }
  | { ok: false; error: string };

type TokenType = "word" | "phrase" | "and" | "or" | "not" | "lparen" | "rparen";

type Token = {
  type: TokenType;
  value?: string;
  pos: number;
};

type Expr =
  | { type: "term"; value: string }
  | { type: "and"; left: Expr; right: Expr }
  | { type: "or"; left: Expr; right: Expr }
  | { type: "not"; expr: Expr };

const isWhitespace = (char: string): boolean => /\s/.test(char);

const isStartOfPrimary = (token: Token | undefined): boolean => {
  if (!token) {
    return false;
  }
  return (
    token.type === "word" ||
    token.type === "phrase" ||
    token.type === "lparen" ||
    token.type === "not"
  );
};

const tokenize = (input: string): { ok: true; tokens: Token[] } | { ok: false; error: string } => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i] ?? "";
    if (isWhitespace(char)) {
      i += 1;
      continue;
    }
    if (char === "(") {
      tokens.push({ type: "lparen", pos: i });
      i += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ type: "rparen", pos: i });
      i += 1;
      continue;
    }
    if (char === "\"") {
      const start = i;
      i += 1;
      let value = "";
      let escaped = false;
      while (i < input.length) {
        const next = input[i] ?? "";
        if (escaped) {
          value += next;
          escaped = false;
          i += 1;
          continue;
        }
        if (next === "\\") {
          escaped = true;
          i += 1;
          continue;
        }
        if (next === "\"") {
          i += 1;
          break;
        }
        value += next;
        i += 1;
      }
      if (escaped || input[i - 1] !== "\"") {
        return { ok: false, error: `Unterminated quote at position ${String(start)}` };
      }
      tokens.push({ type: "phrase", value, pos: start });
      continue;
    }
    if (char === "!" || char === "-") {
      tokens.push({ type: "not", pos: i });
      i += 1;
      continue;
    }

    const start = i;
    let value = "";
    while (i < input.length) {
      const next = input[i] ?? "";
      if (isWhitespace(next) || next === "(" || next === ")") {
        break;
      }
      value += next;
      i += 1;
    }
    if (!value) {
      return { ok: false, error: `Unexpected character at position ${String(start)}` };
    }
    const upper = value.toUpperCase();
    if (upper === "AND") {
      tokens.push({ type: "and", pos: start });
    } else if (upper === "OR") {
      tokens.push({ type: "or", pos: start });
    } else if (upper === "NOT") {
      tokens.push({ type: "not", pos: start });
    } else {
      tokens.push({ type: "word", value, pos: start });
    }
  }
  return { ok: true, tokens };
};

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): Expr {
    const expr = this.parseOr();
    if (!this.isAtEnd()) {
      const token = this.peek();
      const display = token?.value ?? token?.type ?? "unknown";
      throw new Error(
        `Unexpected token "${display}" at position ${String(token?.pos ?? 0)}`,
      );
    }
    return expr;
  }

  private parseOr(): Expr {
    let expr = this.parseAnd();
    while (this.match("or")) {
      const right = this.parseAnd();
      expr = { type: "or", left: expr, right };
    }
    return expr;
  }

  private parseAnd(): Expr {
    let expr = this.parseUnary();
    while (true) {
      if (this.match("and")) {
        const right = this.parseUnary();
        expr = { type: "and", left: expr, right };
        continue;
      }
      if (isStartOfPrimary(this.peek())) {
        const right = this.parseUnary();
        expr = { type: "and", left: expr, right };
        continue;
      }
      break;
    }
    return expr;
  }

  private parseUnary(): Expr {
    if (this.match("not")) {
      const expr = this.parseUnary();
      return { type: "not", expr };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    if (this.match("lparen")) {
      const expr = this.parseOr();
      if (!this.match("rparen")) {
        const token = this.peek();
        throw new Error(`Expected ")" at position ${String(token?.pos ?? 0)}`);
      }
      return expr;
    }
    const token = this.advance();
    if (!token) {
      throw new Error("Unexpected end of query");
    }
    if (token.type === "word" || token.type === "phrase") {
      return { type: "term", value: (token.value ?? "").toLowerCase() };
    }
    const display = token.value ?? token.type;
    throw new Error(
      `Expected term at position ${String(token.pos)}, found "${display}"`,
    );
  }

  private match(type: TokenType): boolean {
    if (this.peek()?.type === type) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private advance(): Token | undefined {
    if (this.index >= this.tokens.length) {
      return undefined;
    }
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private isAtEnd(): boolean {
    return this.index >= this.tokens.length;
  }
}

const evaluate = (expr: Expr, message: string): boolean => {
  switch (expr.type) {
    case "term":
      return message.includes(expr.value);
    case "and":
      return evaluate(expr.left, message) && evaluate(expr.right, message);
    case "or":
      return evaluate(expr.left, message) || evaluate(expr.right, message);
    case "not":
      return !evaluate(expr.expr, message);
  }
};

export const compileQuery = (input: string): QueryCompileResult => {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "Empty query" };
  }
  const tokenized = tokenize(trimmed);
  if (!tokenized.ok) {
    return { ok: false, error: tokenized.error };
  }
  if (tokenized.tokens.length === 0) {
    return { ok: false, error: "Empty query" };
  }
  try {
    const parser = new Parser(tokenized.tokens);
    const expr = parser.parse();
    return {
      ok: true,
      predicate: (message: string) => evaluate(expr, message.toLowerCase()),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid query",
    };
  }
};
