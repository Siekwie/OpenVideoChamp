// Human names for ffmpeg's xfade transitions, grouped for the picker.
export const TRANSITION_GROUPS = [
  ['Fades', [['fade', 'Crossfade'], ['fadeblack', 'Dip to black'], ['fadewhite', 'Dip to white'], ['fadegrays', 'Fade through grey'], ['dissolve', 'Dissolve'], ['fadefast', 'Fast fade'], ['fadeslow', 'Slow fade']]],
  ['Wipes', [['wipeleft', 'Wipe left'], ['wiperight', 'Wipe right'], ['wipeup', 'Wipe up'], ['wipedown', 'Wipe down'], ['wipetl', 'Wipe to top-left'], ['wipetr', 'Wipe to top-right'], ['wipebl', 'Wipe to bottom-left'], ['wipebr', 'Wipe to bottom-right'], ['smoothleft', 'Soft wipe left'], ['smoothright', 'Soft wipe right'], ['smoothup', 'Soft wipe up'], ['smoothdown', 'Soft wipe down']]],
  ['Slides', [['slideleft', 'Slide left'], ['slideright', 'Slide right'], ['slideup', 'Slide up'], ['slidedown', 'Slide down'], ['coverleft', 'Cover left'], ['coverright', 'Cover right'], ['coverup', 'Cover up'], ['coverdown', 'Cover down'], ['revealleft', 'Reveal left'], ['revealright', 'Reveal right'], ['revealup', 'Reveal up'], ['revealdown', 'Reveal down']]],
  ['Shapes', [['circleopen', 'Circle open'], ['circleclose', 'Circle close'], ['circlecrop', 'Circle crop'], ['rectcrop', 'Rectangle crop'], ['radial', 'Radial sweep'], ['diagtl', 'Diagonal top-left'], ['diagtr', 'Diagonal top-right'], ['diagbl', 'Diagonal bottom-left'], ['diagbr', 'Diagonal bottom-right'], ['horzopen', 'Horizontal open'], ['horzclose', 'Horizontal close'], ['vertopen', 'Vertical open'], ['vertclose', 'Vertical close']]],
  ['Effects', [['pixelize', 'Pixelize'], ['hblur', 'Blur'], ['distance', 'Distance'], ['zoomin', 'Zoom in'], ['squeezeh', 'Squeeze horizontal'], ['squeezev', 'Squeeze vertical'], ['hlslice', 'Slices left'], ['hrslice', 'Slices right'], ['vuslice', 'Slices up'], ['vdslice', 'Slices down'], ['hlwind', 'Wind left'], ['hrwind', 'Wind right'], ['vuwind', 'Wind up'], ['vdwind', 'Wind down']]],
];

const LABELS = new Map(TRANSITION_GROUPS.flatMap(([, items]) => items));

export function transitionLabel(type) {
  if (type === 'cut') return 'Cut';
  return LABELS.get(type) || type;
}

// Groups restricted to what the running ffmpeg supports (from /api/info).
export function availableGroups(supported) {
  const ok = supported && supported.length ? new Set(supported) : null;
  return TRANSITION_GROUPS.map(([name, items]) => [name, items.filter(([type]) => !ok || ok.has(type))]).filter(([, items]) => items.length);
}
