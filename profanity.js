const { RegExpMatcher, englishDataset, englishRecommendedTransformers } = require('obscenity');

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

function containsProfanity(text) {
  return matcher.hasMatch(text);
}

module.exports = { containsProfanity };
