import random, subprocess, json, sys
from emu_real import run, mu
from unicorn.arm_const import UC_ARM_REG_FPSCR
print('FPSCR at start', hex(mu.reg_read(UC_ARM_REG_FPSCR))); mu.reg_write(UC_ARM_REG_FPSCR,0)
random.seed(4)
cfgs=[]
for _ in range(500000):
    cfgs.append([2]+[random.randint(0,200) for _ in range(8)])
for _ in range(500000):  # realistic step-5 grid
    cfgs.append([2]+[random.randrange(50,155,5) for _ in range(8)])
for m in range(0,201,5):
    for ff in range(0,201,5): cfgs.append([2,m,100,100,100,100,100,ff,100])
inp='\n'.join(' '.join(map(str,c)) for c in cfgs)+'\n'
out=subprocess.run(['h/evalc'],input=inp,capture_output=True,text=True).stdout.splitlines()
cnt=dict(real_vs_arm_emul=0,real_vs_strict=0,real_vs_app=0,axes=0); ex=[]
for c,line in zip(cfgs,out):
    r=run(*c)
    for a,part in enumerate(line.split('|')):
        v=list(map(int,part.split())); s,arm,app=v[0:5],v[5:10],v[10:15]
        rr=[r[a][k] for k in ('P','I','D','F','d_max')]
        cnt['axes']+=1
        if rr!=arm: cnt['real_vs_arm_emul']+=1; ex.append((c,a,rr,arm))
        if rr!=s: cnt['real_vs_strict']+=1
        if rr!=app: cnt['real_vs_app']+=1
print(json.dumps(cnt)); print(ex[:5])
json.dump(dict(configs=len(cfgs),**cnt,examples_real_vs_arm=ex[:20]),open('real_emu_check_1M.json','w'))
