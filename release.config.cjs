module.exports = {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/exec",
      {
        prepareCmd: "node scripts/release-prepare.mjs ${nextRelease.version}",
      },
    ],
    "@semantic-release/github",
  ],
};
