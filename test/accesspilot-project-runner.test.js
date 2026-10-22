import {test,expect} from "vitest";
import http from "node:http";
import {normalizeProjectConfig} from "../tools/accesspilot/project-config.js";
import {runProject} from "../tools/accesspilot/project-runner.js";

test.skipIf(process.env.ACCESSPILOT_BROWSER_TESTS!=="1")(
  "a completely unrelated web application is explored without a button map",async()=>{
  const html=`<!doctype html><html lang="ru"><head><title>Library</title></head><body>
    <main><h1>My Library</h1>
      <button id="open">Open preferences</button>
      <section id="preferences" hidden>
        <h2>Preferences</h2>
        <button id="apply">Apply</button>
        <input id="unnamed" placeholder="Bad accessibility">
      </section>
    </main>
    <script>
      document.getElementById('open').addEventListener('click',()=>{
        document.getElementById('preferences').hidden=false
      });
      document.getElementById('apply').addEventListener('click',()=>{
        document.getElementById('apply').textContent='Applied';
        fetch('/fail')
      });
    </script></body></html>`;
  const server=http.createServer((request,response)=>{
    if(request.url==="/fail"){
      response.writeHead(503,{"content-type":"text/plain"});
      response.end("isolated test failure");
      return;
    }
    response.setHeader("content-type","text/html; charset=utf-8");
    response.end(html);
  });
  await new Promise(done=>server.listen(0,"127.0.0.1",done));
  try{
    const port=server.address().port;
    const config=normalizeProjectConfig({
      version:1,name:"Library not Bulbam",
      url:"http://127.0.0.1:"+port,
      mode:"explore",
      scenarios:[{name:"guest",profile:"guest",ready:"main"}],
      screens:[
        {name:"Library",selector:"main"},
        {name:"Preferences",selector:"#preferences"}
      ],
      limits:{maxActions:30,maxStates:10,maxDepth:3}
    });
    const result=await runProject(config,{
      outputDir:"/tmp/accesspilot-unrelated-test-"+process.pid,
      logger:{log(){}}
    });
    expect(result.summary.actions).toBeGreaterThanOrEqual(2);
    expect(result.summary.screens).toEqual([
      {name:"Library",selector:"main",visited:true},
      {name:"Preferences",selector:"#preferences",visited:true}
    ]);
    expect(result.findings.groups.some(issue=>
      issue.selector==="#unnamed"&&
      ["missing-name","wcag-label"].includes(issue.code)
    )).toBe(true);
    expect(result.scenarios[0].actions).toContainEqual(
      expect.objectContaining({selector:"#apply",success:true})
    );
    expect(result.findings.groups).toContainEqual(expect.objectContaining({
      code:"http-server-error",selector:"#apply",severity:"serious"
    }));
  }finally{await new Promise(done=>server.close(done));}
},45000);
