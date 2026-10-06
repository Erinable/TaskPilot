// Splits "foo `bar` baz" into text and code parts; empty parts are dropped.
export const inlineCodeParts = (text: string) => text.split('`')
  .map((part, index) => ({ text: part, code: index % 2 === 1 }))
  .filter((part) => part.text !== '');
