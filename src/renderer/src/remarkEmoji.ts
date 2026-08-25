import { visit } from 'unist-util-visit'
import { replaceShortcodes } from '../../shared/emoji'

/**
 * Renders `:tada:` as 🎉 in chat. A remark plugin rather than a string pass over
 * the raw markdown because remark has already separated prose from code: only
 * `text` nodes are visited, so a `:shortcode:` inside a fence or backticks —
 * where it is usually a literal being discussed — survives untouched.
 */
export function remarkEmoji() {
  return (tree: import('mdast').Root): void => {
    visit(tree, 'text', (node: { value: string }) => {
      node.value = replaceShortcodes(node.value)
    })
  }
}
