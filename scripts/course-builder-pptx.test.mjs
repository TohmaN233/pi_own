import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import test from 'node:test';
import {extractPptx} from '../packages/course-builder-host/src/index.ts';
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function zip(entries){const parts=[],directory=[];let offset=0;for(const[name,content]of entries){const n=Buffer.from(name),raw=Buffer.from(content),packed=deflateRawSync(raw),header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(8,8);header.writeUInt32LE(crc32(raw),14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(raw.length,22);header.writeUInt16LE(n.length,26);parts.push(header,n,packed);const d=Buffer.alloc(46);d.writeUInt32LE(0x02014b50);d.writeUInt16LE(20,6);d.writeUInt16LE(8,10);d.writeUInt32LE(crc32(raw),16);d.writeUInt32LE(packed.length,20);d.writeUInt32LE(raw.length,24);d.writeUInt16LE(n.length,28);d.writeUInt32LE(offset,42);directory.push(d,n);offset+=header.length+n.length+packed.length;}const dir=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,dir,end]);}
const entries=[
 ['ppt/presentation.xml','<p:presentation><p:sldIdLst><p:sldId id="1" r:id="r2"/><p:sldId id="2" r:id="r1"/></p:sldIdLst></p:presentation>'],
 ['ppt/_rels/presentation.xml.rels','<Relationships><Relationship Id="r1" Target="slides/slide1.xml" Type="x/slide"/><Relationship Id="r2" Target="slides/slide2.xml" Type="x/slide"/></Relationships>'],
 ['ppt/slides/slide1.xml','<p:sld><a:p><a:r><a:t>Second &amp; &#x4e2d;</a:t></a:r></a:p></p:sld>'],
 ['ppt/slides/slide2.xml','<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>'],
 ['ppt/slides/_rels/slide2.xml.rels','<Relationships><Relationship Id="n1" Target="../notesSlides/notesSlide1.xml" Type="x/notesSlide"/></Relationships>'],
 ['ppt/notesSlides/notesSlide1.xml','<p:notes><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:notes>'],
];
test('PPTX actual presentation relationship order and notes, not lexical filenames',()=>{const p=extractPptx(zip(entries));assert.equal(p.metadata.slideCount,2);assert.equal(p.metadata.slides[0].text,'First');assert.equal(p.metadata.slides[0].notes,'Speaker note');assert.equal(p.metadata.slides[1].text,'Second & 中');});
test('PPTX rejects duplicate entries, escaping relationships and DTD without expanding',()=>{
 assert.throws(()=>extractPptx(zip([...entries,entries[0]])),/duplicate/);
 assert.throws(()=>extractPptx(zip(entries.map(([n,c])=>[n,c.replace('slides/slide2.xml','../../outside.xml')]))),/escapes/);
 assert.throws(()=>extractPptx(zip(entries.map(([n,c])=>[n,n.endsWith('presentation.xml')?'<!DOCTYPE x SYSTEM "file:///etc/passwd">'+c:c]))),/DTD/);
});
test('PPTX inflate budget is enforced before allocating expanded payload',()=>{const bomb=entries.map(([n,c])=>[n,n==='ppt/slides/slide2.xml'?'x'.repeat(5*1024*1024):c]);assert.throws(()=>extractPptx(zip(bomb)),/budget/);});
test('PPTX detects corrupted archive bytes and unsupported container',()=>{const p=zip(entries);p[45]^=1;assert.throws(()=>extractPptx(p));assert.throws(()=>extractPptx(Buffer.from('not a pptx')),/archive/);});
