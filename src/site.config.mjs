/* Site-wide metadata. Everything the layout needs that is not per-post. */
export default {
  name: 'bherms',
  title: 'Brad Herman',
  tagline: 'Thoughts on the world and how to live',
  origin: 'https://blog.bherms.com',
  author: 'Brad Herman',
  /* Shown under the title on the home page, in <meta> tags, and in the feed. */
  description:
    'Analytical pieces, essays, notes on what I am building, and the odd ' +
    'recommendation. Strong opinions, weakly held — I like being proven ' +
    'wrong. Kept short.',
  /* A standing promise to the reader, so it sits in the footer of every page
     rather than being buried in a welcome post nobody scrolls back to. */
  aiPolicy:
    'Written by me, sometimes with a bit of help — but if it is mostly AI, ' +
    'I will be explicit about it.',
  /* bherms.com is the canonical site; bradleytherman.com forwards to it. */
  nav: [
    { label: 'Writing', href: '/' },
    { label: 'bherms.com', href: 'https://bherms.com' }
  ]
};
