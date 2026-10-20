// Generate the small monochrome picture glyph used by the status bar.
// Coordinates are in a 1024-unit square, with y increasing upwards.
const fs = require('node:fs');
const zlib = require('node:zlib');
const u16 = values => { const b = Buffer.alloc(values.length * 2); values.forEach((v, i) => b.writeUInt16BE(v & 65535, i * 2)); return b; };
const u32 = values => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };
const pad = b => Buffer.concat([b, Buffer.alloc((4 - b.length % 4) % 4)]);
const sum = b => { b = pad(b); let n = 0; for (let i = 0; i < b.length; i += 4) n = (n + b.readUInt32BE(i)) >>> 0; return n; };
const contours = [
  [[128,192],[128,832],[896,832],[896,192]],
  [[192,256],[832,256],[832,768],[192,768]],
  [[192,256],[384,544],[576,352],[704,512],[832,320],[832,256]],
  [[656,656],[656,704],[688,736],[736,736],[768,704],[768,656],[736,624],[688,624]]
];
const points = contours.flat(), ends = []; let count = 0;
for (const contour of contours) ends.push((count += contour.length) - 1);
const delta = axis => { let previous = 0; return points.map(p => { const d = p[axis] - previous; previous = p[axis]; return d; }); };
const glyph = pad(Buffer.concat([u16([contours.length,128,192,896,832,...ends,0]), Buffer.alloc(points.length, 1), u16(delta(0)), u16(delta(1))]));
const head = Buffer.alloc(54); head.writeUInt32BE(0x10000); head.writeUInt32BE(0x10000, 4); head.writeUInt32BE(0x5f0f3cf5, 12); head.writeUInt16BE(1024, 18);
u16([128,192,896,832,0,8,2,1,0]).copy(head, 36);
const names = ['QQ Icons','Regular','QQ Icons Regular','QQIcons']; let offset = 0;
const strings = names.map(value => { const b = Buffer.from(value, 'utf16le'); return b.swap16(); });
const name = Buffer.concat([u16([0,4,54]), ...strings.map((b, i) => { const record = u16([3,1,0x409,[1,2,4,6][i],b.length,offset]); offset += b.length; return record; }), ...strings]);
const os2 = Buffer.alloc(78); u16([0,1024,400,5,0]).copy(os2); Buffer.from('QQIC').copy(os2,58); u16([64,0xe001,0xe001,1024,0,0,1024,0]).copy(os2,62);
const tables = {
  'OS/2': os2,
  cmap: Buffer.concat([u16([0,1,3,1]),u32([12]),u16([4,32,0,4,4,1,0,0xe001,0xffff,0,0xe001,0xffff,1-0xe001,1,0,0])]),
  glyf: glyph, head,
  hhea: Buffer.concat([u32([0x10000]),u16([1024,0,0,1024,0,0,896,1,0,0,0,0,0,0,0,2])]),
  hmtx: u16([1024,0,1024,128]), loca: u32([0,0,glyph.length]),
  maxp: Buffer.concat([u32([0x10000]),u16([2,points.length,contours.length,0,0,1,0,0,0,0,0,0,0,0])]),
  name, post: Buffer.concat([u32([0x30000,0]),u16([-64,64]),Buffer.alloc(20)])
};
const tags = Object.keys(tables).sort(), power = 2 ** Math.floor(Math.log2(tags.length));
const sfntHeader = Buffer.concat([u32([0x10000]),u16([tags.length,power*16,Math.log2(power),(tags.length-power)*16])]);
let cursor = 12 + tags.length * 16;
const records = tags.map(tag => { const b = tables[tag], record = Buffer.concat([Buffer.from(tag),u32([sum(b),cursor,b.length])]); cursor += pad(b).length; return record; });
head.writeUInt32BE((0xb1b0afba - sum(Buffer.concat([sfntHeader,...records,...tags.map(tag=>pad(tables[tag]))]))) >>> 0, 8);
cursor = 44 + tags.length * 20;
const blocks = [], directory = tags.map((tag, i) => {
  const raw = tables[tag], compressed = zlib.deflateSync(raw), b = compressed.length < raw.length ? compressed : raw;
  const record = Buffer.concat([Buffer.from(tag),u32([cursor,b.length,raw.length,records[i].readUInt32BE(4)])]);
  blocks.push(pad(b)); cursor += pad(b).length; return record;
});
const header = Buffer.concat([Buffer.from('wOFF'),u32([0x10000,cursor]),u16([tags.length,0]),u32([12+tags.length*16+tags.reduce((n,t)=>n+pad(tables[t]).length,0)]),u16([1,0]),Buffer.alloc(20)]);
fs.writeFileSync(require('node:path').join(__dirname, '..', 'media', 'qq-icons.woff'), Buffer.concat([header,...directory,...blocks]));
