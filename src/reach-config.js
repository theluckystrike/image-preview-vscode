'use strict';
// REACH1: this listing's Pro tools for the Explorer entries (src/reach.js). The free core has no webview, so there is
// no toolbar row; the entries show on folders only, and only while imgPreview.showProTools is on.
module.exports = {
  prefix: 'imgPreview',
  triesKey: 'imgPreview.proTrial',
  slot: '#toolbar',
  tools: [
    { id: 'unused', title: 'Find unused images', command: 'imgPreview.findUnused' },
    { id: 'broken', title: 'Find broken image references', command: 'imgPreview.findBroken' },
    { id: 'weight', title: 'Image weight report', command: 'imgPreview.weightReport' },
  ],
};
