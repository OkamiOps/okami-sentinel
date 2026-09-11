import { useCallback, useEffect, useRef, useState } from 'react';
import { Focus, Maximize2, Minus, Plus, Tags } from 'lucide-react';
import type { ScanFilesGraph } from '../../api';
import { createFileGraph, graphNeighbors, graphColors as colors, type FileNode } from '../../lib/file-graph';
import { Button } from '../ui/button';
import { useI18n } from '../../i18n';
import { filesCopy } from './files-copy';

export function FileGraphCanvas({data,selected,query,onSelect}:{data:ScanFilesGraph;selected:string;query:string;onSelect:(id:string)=>void}) {
 const {locale}=useI18n(),c=filesCopy[locale];
 const canvas=useRef<HTMLCanvasElement>(null),host=useRef<HTMLDivElement>(null);
 const graph=useRef<ReturnType<typeof createFileGraph>|null>(null);
 const camera=useRef({x:0,y:0,k:1}),size=useRef({w:900,h:620});
 const interaction=useRef<{x:number;y:number;moved:boolean;node?:FileNode}|null>(null);
 const hover=useRef(''),options=useRef({selected,query,labels:false,focus:false});
 const [labels,setLabels]=useState(false),[focus,setFocus]=useState(false),[zoom,setZoom]=useState(100);
 options.current={selected,query,labels,focus};
 const draw=useCallback(()=>{
  const el=canvas.current,g=graph.current;if(!el||!g)return;const ctx=el.getContext('2d');if(!ctx)return;
  const {w,h}=size.current,{x,y,k}=camera.current,opts=options.current;
  const foreground=getComputedStyle(el).color; const active=hover.current||opts.selected;const neighbors=graphNeighbors(g.links,active);
  const groups=[...new Set(g.nodes.map(n=>n.group))].sort();
  ctx.clearRect(0,0,w,h);ctx.save();ctx.translate(w/2+x,h/2+y);ctx.scale(k,k);
  for(const e of g.links){const connected=e.source.id===active||e.target.id===active;if(opts.focus&&active&&!connected)continue;ctx.strokeStyle=connected?'#62d9d4':foreground;ctx.globalAlpha=active?(connected?0.6:0.035):0.12;ctx.lineWidth=(connected?1.3:0.65)/k;ctx.beginPath();ctx.moveTo(e.source.x!,e.source.y!);ctx.lineTo(e.target.x!,e.target.y!);ctx.stroke();}
  const labelCandidates=[...g.nodes].sort((a,b)=>Number(b.id===active)-Number(a.id===active)||b.degree-a.degree);const boxes:Array<{x:number;y:number;w:number;h:number}>=[];
  for(const n of g.nodes){if(opts.focus&&active&&!neighbors.has(n.id))continue;const match=!opts.query||n.id.toLowerCase().includes(opts.query.toLowerCase());const related=!active||neighbors.has(n.id);ctx.globalAlpha=match&&related?1:0.16;const radius=Math.max(2.5/k,Math.min(10,2.6+Math.sqrt(n.degree)*0.55));ctx.fillStyle=colors[groups.indexOf(n.group)%colors.length];ctx.beginPath();ctx.arc(n.x!,n.y!,radius,0,Math.PI*2);ctx.fill();if(n.id===active){ctx.globalAlpha=0.8;ctx.strokeStyle=foreground;ctx.lineWidth=1.2/k;ctx.beginPath();ctx.arc(n.x!,n.y!,radius+4/k,0,Math.PI*2);ctx.stroke();}}
  ctx.font=`${11/k}px system-ui`;ctx.textAlign='left';ctx.textBaseline='middle';
  for(const n of labelCandidates){if(opts.focus&&active&&!neighbors.has(n.id))continue;const match=opts.query&&n.id.toLowerCase().includes(opts.query.toLowerCase());const important=n.id===active||!!match;const show=important||opts.labels||k>1.8||(active?neighbors.has(n.id)&&k>0.7:n.degree>20);if(!show)continue;const label=n.id.split('/').pop()!;const nx=n.x!+(Math.max(2.5/k,Math.min(10,2.6+Math.sqrt(n.degree)*0.55))+5/k),ny=n.y!;const box={x:nx,y:ny-7/k,w:ctx.measureText(label).width+8/k,h:14/k};if(!important&&boxes.some(b=>box.x<b.x+b.w&&box.x+box.w>b.x&&box.y<b.y+b.h&&box.y+box.h>b.y))continue;boxes.push(box);ctx.globalAlpha=active&&!neighbors.has(n.id)?0.16:0.85;ctx.fillStyle=foreground;ctx.fillText(label,nx,ny);}
  ctx.restore();ctx.globalAlpha=1;
 },[]);
 const fit=useCallback(()=>{const g=graph.current;if(!g?.nodes.length)return;const xs=g.nodes.map(n=>n.x!),ys=g.nodes.map(n=>n.y!);const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);const k=Math.max(0.08,Math.min(2,(size.current.w-100)/Math.max(100,maxX-minX),(size.current.h-100)/Math.max(100,maxY-minY)));camera.current={k,x:-(minX+maxX)*k/2,y:-(minY+maxY)*k/2};setZoom(Math.round(k*100));draw();},[draw]);
 useEffect(()=>{const g=createFileGraph(data);graph.current=g;let frame=0,ticks=0;const step=()=>{g.simulation.tick(8);ticks+=8;if(ticks===8||ticks>=240)fit();else draw();if(ticks<240)frame=requestAnimationFrame(step);};if(window.matchMedia("(prefers-reduced-motion: reduce)").matches){g.simulation.tick(240);fit();}else frame=requestAnimationFrame(step);return()=>{cancelAnimationFrame(frame);g.simulation.stop();};},[data,draw,fit]);
 useEffect(()=>{const el=canvas.current,container=host.current;if(!el||!container)return;const observer=new ResizeObserver(()=>{const r=container.getBoundingClientRect(),ratio=window.devicePixelRatio||1;size.current={w:r.width,h:r.height};el.width=r.width*ratio;el.height=r.height*ratio;el.getContext('2d')?.setTransform(ratio,0,0,ratio,0,0);fit();});observer.observe(container);return()=>observer.disconnect();},[fit]);
 useEffect(()=>{if(selected){const n=graph.current?.byId.get(selected);if(n){const k=Math.max(camera.current.k,0.85);camera.current={k,x:-n.x!*k,y:-n.y!*k};setZoom(Math.round(k*100));}}draw();},[selected,query,labels,focus,draw]);
 const changeZoom=(factor:number)=>{const old=camera.current.k;camera.current.k=Math.max(0.08,Math.min(6,old*factor));camera.current.x*=camera.current.k/old;camera.current.y*=camera.current.k/old;setZoom(Math.round(camera.current.k*100));draw();};
 useEffect(()=>{const el=canvas.current;if(!el)return;const wheel=(e:WheelEvent)=>{e.preventDefault();const r=el.getBoundingClientRect(),px=e.clientX-r.left-size.current.w/2,py=e.clientY-r.top-size.current.h/2;const old=camera.current.k,next=Math.max(0.08,Math.min(6,old*Math.exp(-e.deltaY*0.002)));camera.current={k:next,x:px-(px-camera.current.x)*next/old,y:py-(py-camera.current.y)*next/old};setZoom(Math.round(next*100));draw();};el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);},[draw]);
 const point=(e:React.PointerEvent)=>{const r=canvas.current!.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};};
 const hit=(x:number,y:number)=>{const cam=camera.current,wx=(x-size.current.w/2-cam.x)/cam.k,wy=(y-size.current.h/2-cam.y)/cam.k;const near=options.current.focus&&options.current.selected?graphNeighbors(graph.current?.links??[],options.current.selected):null;return graph.current?.nodes.filter(n=>!near||near.has(n.id)).find(n=>Math.hypot(n.x!-wx,n.y!-wy)<Math.max(8/cam.k,3+Math.sqrt(n.degree)*0.55));};
 return <div className="relative h-[520px] min-w-0 bg-background sm:h-[650px]" ref={host}>
  <canvas ref={canvas} role="img" aria-label={c.graph} className="h-full w-full touch-none text-foreground" tabIndex={0}
   onKeyDown={e=>{if(e.key==='+'||e.key==='='){e.preventDefault();changeZoom(1.2);}else if(e.key==='-'){e.preventDefault();changeZoom(1/1.2);}else if(e.key==='Escape'){onSelect('');setFocus(false);fit();}else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();camera.current.x+=e.key==='ArrowLeft'?30:e.key==='ArrowRight'?-30:0;camera.current.y+=e.key==='ArrowUp'?30:e.key==='ArrowDown'?-30:0;draw();}}}
   onPointerDown={e=>{const p=point(e);interaction.current={...p,moved:false,node:hit(p.x,p.y)};e.currentTarget.setPointerCapture(e.pointerId);}}
   onPointerMove={e=>{const p=point(e),drag=interaction.current;if(drag){const dx=p.x-drag.x,dy=p.y-drag.y;drag.moved ||= Math.abs(dx)+Math.abs(dy)>2;if(drag.node){drag.node.x!+=dx/camera.current.k;drag.node.y!+=dy/camera.current.k;drag.node.fx=drag.node.x;drag.node.fy=drag.node.y;}else{camera.current.x+=dx;camera.current.y+=dy;}drag.x=p.x;drag.y=p.y;}else{const n=hit(p.x,p.y);hover.current=n?.id??'';e.currentTarget.style.cursor=n?'pointer':'grab';e.currentTarget.title=n?.id??c.gestures;}draw();}}
   onPointerUp={e=>{const drag=interaction.current;if(drag&&!drag.moved)onSelect(drag.node?.id??'');interaction.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);draw();}}
   onPointerCancel={()=>{interaction.current=null;}} onPointerLeave={()=>{hover.current='';draw();}}/>
  <div className="absolute right-3 top-3 flex gap-1 border bg-card/95 p-1 shadow-lg"><Button size="icon" variant="ghost" aria-label={c.zoomIn} title={c.zoomIn} onClick={()=>changeZoom(1.25)}><Plus size={16}/></Button><Button size="icon" variant="ghost" aria-label={c.zoomOut} title={c.zoomOut} onClick={()=>changeZoom(0.8)}><Minus size={16}/></Button><Button size="icon" variant="ghost" aria-label={c.fit} title={c.fit} onClick={fit}><Maximize2 size={16}/></Button><Button size="icon" variant="ghost" aria-label={c.labels} title={c.labels} aria-pressed={labels} onClick={()=>setLabels(v=>!v)}><Tags size={16}/></Button><Button size="icon" variant="ghost" aria-label={c.focus} title={c.focus} disabled={!selected} aria-pressed={focus} onClick={()=>setFocus(v=>!v)}><Focus size={16}/></Button></div>
  <div className="pointer-events-none absolute bottom-3 left-4 right-4 flex justify-between gap-4 text-[10px] text-muted-foreground"><span>{c.gestures}</span><span className="font-mono">{zoom}%</span></div>
 </div>;
}
