import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { speakerGroups, mappedSpeakerAnnotations, annotateTranscript } from '../public/speaker-model.js';
import { WorkflowLibrary, WorkflowRuntime } from '../src/workflow-library.js';

const groups = { source: { id:'group-v1', speakers:[{id:'a'},{id:'b'},{id:'c'}], turns:[{speakerId:'a',startSeconds:0,endSeconds:2},{speakerId:'b',startSeconds:2,endSeconds:4},{speakerId:'c',startSeconds:4,endSeconds:6},{speakerId:'a',startSeconds:6,endSeconds:8,overlap:true}] } };
test('multi-speaker mapping merges same-name groups, excludes unnamed and overlap, and rejects invented groups', () => {
  const a = mappedSpeakerAnnotations(groups, { source:{a:'甲',b:'乙',c:'甲'} });
  assert.equal(a.length,3); assert.deepEqual(a.map(a=>a.speaker),['甲','乙','甲']);
  assert.equal(mappedSpeakerAnnotations(groups,{source:{a:'',b:'乙'}}).length,1);
  assert.throws(()=>mappedSpeakerAnnotations(groups,{source:{invented:'甲'}}));
});
test('speaker attribution uses real time coverage, prevents duplicate inflation and respects manual correction', () => {
  const transcript = { segments:[{text:'一句',startSeconds:0,durationSeconds:2}] };
  const item = {inputKey:'source',speaker:'甲',startSeconds:0,endSeconds:1,provenance:'user-named-voice-cluster'};
  assert.equal(annotateTranscript(transcript,'source',[{annotations:[item,item]}]).segments[0].speakerStatus,'uncertain');
  const whole={...item,endSeconds:2};
  assert.equal(annotateTranscript(transcript,'source',[{annotations:[whole]}]).segments[0].speakerName,'甲');
  assert.equal(annotateTranscript(transcript,'source',[{annotations:[whole,{...whole,speaker:'乙'}]}]).segments[0].speakerStatus,'uncertain');
  assert.equal(annotateTranscript(transcript,'source',[{annotations:[whole,{...whole,speaker:'乙',provenance:'user-segment-correction'}]}]).segments[0].speakerName,'乙');
  assert.equal(annotateTranscript(transcript,'source',[{speakerMappings:{source:{a:'甲'}},annotations:[whole]},{speakerMappings:{source:{a:'乙'}},annotations:[{...whole,speaker:'乙'}]}]).segments[0].speakerName,'乙');
});
test('paused legacy run can group voices then resume analysis with named segments without replaying transcription', async(t)=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'wf-speakers-')); let input=path.join(dir,'input.wav'); await writeFile(input,'sample'); input=await realpath(input); const info=await stat(input);
  const db=new WorkflowLibrary(path.join(dir,'db.sqlite')); const calls=[];
  const runtime=new WorkflowRuntime(db,async({node})=>{
    calls.push(node.tool);
    if(node.tool==='local_speaker_diarize') return {result:{status:'success',output:{...groups.source,id:node.id,inputPath:input,sourceSize:info.size,sourceMtimeMs:info.mtimeMs,provenance:'automatic-voice-clustering'},artifacts:[]}};
    if(node.id==='read') return {result:{status:'success',output:{inputPath:input,segments:[{text:'真实文本',startSeconds:0,durationSeconds:2}]}}};
    if(!node.arguments.transcript.segments[0].speakerName) return {result:{status:'needs_input',error:'请补充说话人确认'}};
    assert.equal(node.arguments.transcript.segments[0].speakerName,'甲'); return {result:{status:'success',output:{done:true}}};
  });
  t.after(async()=>{await runtime.close();db.close();await rm(dir,{recursive:true,force:true});});
  const w=db.save({name:'多人测试',inputs:[{key:'source',label:'音频',type:'audio'}],triggers:['click'],nodes:[{id:'read',type:'tool',tool:'transcribe',title:'转写',arguments:{inputPath:'{{input.source}}'}},{id:'analysis',type:'tool',tool:'agent_transcript_analyze',title:'分析',arguments:{transcript:'{{outputs.read}}'}}],edges:[{from:'read',to:'analysis',when:'always'}]});
  const started=runtime.start(w.id,{inputs:{source:input}},{workspace:dir}); await runtime.jobs.get(started.id);
  let run=db.get('runs',started.id); const token=runtime.recovery(run).token;
  runtime.diarize(run.id,{token,inputKey:'source',numSpeakers:3},{workspace:dir});
  assert.throws(()=>runtime.resume(run.id,{workspace:dir},{token,confirmed:true,note:'test',decision:'approve'}),/等待声音分组/);
  await runtime.jobs.get(run.id); run=db.get('runs',run.id);
  assert.equal(run.status,'waiting_input'); const g=speakerGroups(run); assert.equal(g.source.speakers.length,3);
  const body={token,confirmed:true,note:'已试听代表片段确认姓名',decision:'approve',speakerMappings:{source:{a:'甲',b:'乙',c:'丙'}},speakerGroupVersions:{source:g.source.id}};
  assert.throws(()=>runtime.resume(run.id,{workspace:dir},{...body,speakerGroupVersions:{source:'stale'}}),/重新生成/);
  runtime.resume(run.id,{workspace:dir},body); await runtime.jobs.get(run.id);
  assert.equal(db.get('runs',run.id).status,'complete'); assert.deepEqual(calls,['transcribe','agent_transcript_analyze','local_speaker_diarize','agent_transcript_analyze']);
});
