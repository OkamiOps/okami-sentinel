import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import type { ScanFilesGraph } from "../api";
export interface FileNode extends SimulationNodeDatum { id: string; group: string; degree: number }
export interface FileLink { source: FileNode; target: FileNode; count: number }
export const graphColors=["#57c8c8","#a995ef","#e6b86c","#78b9e8","#db89ad","#91c594","#cbad8b"];
export function fileGroup(file:string) { return file.includes("/") ? file.split("/").slice(0,file.startsWith("apps/")||file.startsWith("packages/")?2:1).join("/") : "/"; }
export function createFileGraph(data: ScanFilesGraph) {
  const nodes: FileNode[] = data.files.map(f => ({ id: f.path, group: fileGroup(f.path), degree: 0 }));
  const byId = new Map(nodes.map(n=>[n.id,n]));
  const links: FileLink[] = [];
  for (const edge of data.edges) { const source=byId.get(edge.source),target=byId.get(edge.target); if (!source || !target) continue; source.degree++;target.degree++;links.push({source,target,count:edge.count}); }
  const simulation = forceSimulation(nodes).stop()
    .force('links',forceLink<FileNode,FileLink>(links).id(n=>n.id).distance(100).strength(0.08))
    .force('charge',forceManyBody<FileNode>().strength(n=>n.degree ? -90 : -4))
    .force('collide',forceCollide<FileNode>().radius(n=>5+Math.sqrt(n.degree)*0.6))
    .force('center',forceCenter(0,0)).force('x',forceX<FileNode>(0).strength(n=>n.degree?0.05:0.2)).force('y',forceY<FileNode>(0).strength(n=>n.degree?0.05:0.2));
  return {nodes,links,byId,simulation};
}
export function graphNeighbors(links: FileLink[], id: string): Set<string> {
  const ids=new Set<string>(id ? [id] : []);
  for(const e of links) { if(e.source.id===id)ids.add(e.target.id);if(e.target.id===id)ids.add(e.source.id); }
  return ids;
}
