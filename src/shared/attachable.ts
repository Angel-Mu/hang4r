/**
 * Extensions the native attach dialog offers by default.
 *
 * Office formats were missing, so a .docx could not be picked at all without
 * switching the dropdown to "All Files" (Angel). Content, not this list, decides
 * how a file is READ — see looksBinary.
 */
export const ATTACHABLE_IMAGES = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']

export const ATTACHABLE_DOCS_AND_CODE = [
      // markdown / text / docs
      'md', 'markdown', 'mdx', 'txt', 'text', 'rtf', 'pdf', 'csv', 'tsv', 'log',
      // office + office-shaped formats: greyed out in the picker before, so they
      // could not be attached at all without switching to "All Files"
      'doc', 'docx', 'odt', 'rtfd', 'pages',
      'xls', 'xlsx', 'ods', 'numbers',
      'ppt', 'pptx', 'odp', 'key',
      'epub',
      // structured / config
      'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm',
      'css', 'scss', 'less', 'ini', 'env', 'conf', 'cfg', 'properties',
      // code
      'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'py', 'rb', 'go',
      'rs', 'java', 'kt', 'kts', 'swift', 'm', 'mm', 'c', 'h', 'cpp', 'cc',
      'cxx', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'sql', 'graphql',
      'gql', 'proto', 'dockerfile', 'makefile', 'gradle', 'lua', 'r', 'dart',
      'ex', 'exs', 'erl', 'clj', 'scala', 'pl', 'diff', 'patch'
]

export const ATTACHABLE_EXTENSIONS = [...ATTACHABLE_DOCS_AND_CODE, ...ATTACHABLE_IMAGES]
