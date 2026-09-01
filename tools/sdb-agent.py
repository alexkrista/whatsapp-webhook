"""Lokaler KRISTINE-SDB-Agent: scannt N:\\SdB und sendet nur Manifest/Metadaten ausgehend per HTTPS."""
import argparse, hashlib, json, os, pathlib, time, urllib.request

def sha256(path):
    digest=hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda:handle.read(1024*1024),b""): digest.update(chunk)
    return digest.hexdigest()

def scan(root, previous):
    result=[]; state={}
    for path in root.rglob("*.pdf"):
        try:
            stat=path.stat(); relative=str(path.relative_to(root)); key=f"{stat.st_size}:{stat.st_mtime_ns}"
            digest=previous.get(relative,{}).get("sha256") if previous.get(relative,{}).get("key")==key else sha256(path)
            state[relative]={"key":key,"sha256":digest}
            if previous.get(relative,{}).get("sha256")!=digest:
                result.append({"relativePath":relative,"sha256":digest,"size":stat.st_size,"modifiedAt":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime(stat.st_mtime))})
        except OSError as error: print(f"Übersprungen: {path}: {error}")
    return result,state

def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--root",default=r"N:\SdB"); parser.add_argument("--url",required=True); parser.add_argument("--token",default=os.getenv("SDB_AGENT_TOKEN","")); parser.add_argument("--state",default="sdb-agent-state.json"); args=parser.parse_args()
    if not args.token: raise SystemExit("SDB_AGENT_TOKEN fehlt")
    root=pathlib.Path(args.root); state_path=pathlib.Path(args.state)
    previous=json.loads(state_path.read_text("utf-8")) if state_path.exists() else {}
    documents,state=scan(root,previous); payload=json.dumps({"agentVersion":"0.1.0","documents":documents}).encode()
    request=urllib.request.Request(args.url.rstrip("/")+"/agent/api/safety/sdb/sync",payload,{"Content-Type":"application/json","X-Kristine-Agent-Token":args.token},method="POST")
    with urllib.request.urlopen(request,timeout=60) as response: print(response.read().decode())
    temp=state_path.with_suffix(".tmp"); temp.write_text(json.dumps(state,indent=2),"utf-8"); temp.replace(state_path)
if __name__=="__main__": main()
