export const codeLanguages = ['c', 'python', 'javascript', 'typescript', 'dart', 'kotlin', 'java', 'swift'] as const;
export type CodeLanguage = typeof codeLanguages[number];
export function isCodeLanguage(value: unknown): value is CodeLanguage {
  return codeLanguages.some(language => language === value);
}

// Formatting affects only the transcript projection, never stored/sent messages.
export function codeStyle(language: CodeLanguage) {
  const python = language === 'python';
  const c = language === 'c';
  const comment = python ? '#' : '//';
  const declaration = language === 'kotlin' ? 'val' : language === 'swift' ? 'let' : language === 'java' ? 'final String' : 'const';
  const terminator = python || language === 'kotlin' || language === 'swift' ? '' : ';';
  return {
    comment,
    constant: (name: string, values: string[]) => c ? `#define ${name} ${values.join(' ')}`
      : python ? `${name} = ${values.length > 1 ? `(${values.join(', ')})` : values[0]}`
      : `${declaration}${language === 'java' && values.length > 1 ? '[]' : ''} ${name} = ${values.length > 1 ? language === 'kotlin' ? `listOf(${values.join(', ')})` : language === 'java' ? `{${values.join(', ')}}` : `[${values.join(', ')}]` : values[0]}${terminator}`,
    function: (name: string) => c ? `void ${name}(void) {` : python ? `def ${name}():`
      : language === 'dart' || language === 'java' ? `void ${name}() {`
      : language === 'kotlin' ? `fun ${name}() {` : language === 'swift' ? `func ${name}() {`
      : `function ${name}()${language === 'typescript' ? ': void' : ''} {`,
    string: (name: string) => c ? `    char ${name}[] = "` : python ? `    ${name} = (` + '"'
      : language === 'dart' || language === 'java' ? `    String ${name} = "`
      : language === 'kotlin' ? `    val ${name} = "` : language === 'swift' ? `    let ${name} = "`
      : `    const ${name}${language === 'typescript' ? ': string' : ''} = "`,
    resource: (name: string) => c ? `    char *${name} = "` : python ? `    ${name} = (` + '"'
      : language === 'dart' || language === 'java' ? `    String ${name} = "`
      : language === 'kotlin' ? `    val ${name} = "` : language === 'swift' ? `    let ${name} = "`
      : `    const ${name}${language === 'typescript' ? ': string' : ''} = "`,
    stringEnd: python ? '")' : `"${terminator}`,
    continuation: c ? '                 "' : '        "',
    join: ['javascript', 'typescript', 'kotlin', 'java', 'swift'].includes(language) ? ' +' : '',
    ending: python ? '    # end' : '}',
    escape: (escaped: string) => {
      if (language === 'dart') return escaped.replace(/\$/g, '\\$');
      if (language === 'kotlin') return escaped.replace(/\\(f|.)/g, (match, code: string) => code === 'f' ? '\\u000c' : match).replace(/\$/g, '\\$');
      // Swift uses braced Unicode escapes and does not accept JSON's \b/\f.
      if (language === 'swift') return escaped.replace(/\\(u([0-9a-fA-F]{4})|b|f|.)/g, (match, code: string, hex: string) =>
        hex ? `\\u{${hex}}` : code === 'b' ? '\\u{0008}' : code === 'f' ? '\\u{000c}' : match);
      return escaped;
    },
  };
}
