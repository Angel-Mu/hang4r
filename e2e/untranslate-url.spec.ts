import { test, expect } from '@playwright/test'
import { untranslateUrl } from '../src/renderer/src/components/BrowserPane'

/**
 * Angel: "I'm starting to see 'traductor' when I search and click on a link
 * through the browser". Google search served to a non-English locale can route
 * a click through its website-translation proxy, so you land on a machine
 * translation instead of the page you picked.
 */
test.describe('untranslateUrl', () => {
  test('unwraps the translate proxy back to the real host', () => {
    expect(untranslateUrl('https://www-example-com.translate.goog/docs?x=1')).toBe(
      'https://www.example.com/docs?x=1'
    )
  })

  test('a literal dash in the host survives the round trip', () => {
    // Google encodes '.' as '-' and '-' as '--', so my-site.com is my--site-com
    expect(untranslateUrl('https://my--site-com.translate.goog/')).toBe('https://my-site.com/')
  })

  test('drops the proxy’s own language parameters', () => {
    expect(
      untranslateUrl('https://impeccable-style.translate.goog/?_x_tr_sl=en&_x_tr_tl=es&keep=yes')
    ).toBe('https://impeccable.style/?keep=yes')
  })

  test('unwraps the websitetranslationui wrapper Angel actually hit', () => {
    const wrapper =
      'https://translate.google.com/websitetranslationui?parent=https%3A%2F%2Fimpeccable-style.translate.goog' +
      '&pfu=https%3A%2F%2Fimpeccable-style.translate.goog%2F%3F_x_tr_sl%3Den'
    expect(untranslateUrl(wrapper)).toBe('https://impeccable.style/')
  })

  test('leaves ordinary URLs alone', () => {
    expect(untranslateUrl('https://example.com/a?b=c')).toBeNull()
    expect(untranslateUrl('https://translate.google.com/')).toBeNull()
    expect(untranslateUrl('not a url')).toBeNull()
  })
})

// The unwrap runs on every navigation, so the pane checks whether the URL the
// user themselves entered is already a translate address — otherwise opening one
// on purpose would be impossible.
test('a translate address is still recognisable as one the user asked for', () => {
  // this is the check the pane makes against the tab's own url
  expect(untranslateUrl('https://impeccable-style.translate.goog/')).not.toBeNull()
  expect(untranslateUrl('https://example.com/')).toBeNull()
})

