import test from "node:test";
import assert from "node:assert/strict";
import { compileQuery } from "../dist/store/query.js";

const expectMatch = (query, message, expected) => {
  const compiled = compileQuery(query);
  assert.equal(compiled.ok, true, `expected query to compile: ${query}`);
  const result = compiled.predicate(message);
  assert.equal(result, expected, `query ${query} on ${message}`);
};

test("AND / OR / precedence", () => {
  expectMatch("foo AND bar", "foo bar", true);
  expectMatch("foo AND bar", "foo", false);
  expectMatch("foo OR bar", "foo", true);
  expectMatch("foo OR bar", "baz", false);
  expectMatch("foo AND (bar OR baz)", "foo baz", true);
  expectMatch("foo AND (bar OR baz)", "foo qux", false);
});

test("NOT / unary negation", () => {
  expectMatch("NOT foo", "foo", false);
  expectMatch("NOT foo", "bar", true);
  expectMatch("!foo", "foo", false);
  expectMatch("-foo", "foo", false);
});

test("implicit AND", () => {
  expectMatch("foo bar", "foo bar", true);
  expectMatch("foo bar", "foo", false);
});

test("phrases and case-insensitive", () => {
  expectMatch('"Exact Phrase"', "exact phrase", true);
  expectMatch("ERROR", "some error happened", true);
  expectMatch("ERROR", "all good", false);
});

test("invalid queries", () => {
  const invalid = ["(", "foo AND", '"unterminated', "AND foo"];
  for (const query of invalid) {
    const compiled = compileQuery(query);
    assert.equal(compiled.ok, false, `expected invalid: ${query}`);
  }
});
