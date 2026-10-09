# Execute the REAL calculateNewPidValues from betaflight_STM32F405.elf (built at 4fc1520c with gcc 13.3.1) in unicorn.
import struct, sys, json
sys.path.insert(0, 'py')
from unicorn import *
from unicorn.arm_const import *
ELF='bf/obj/main/betaflight_STM32F405.elf'
data=open(ELF,'rb').read()
e_phoff,=struct.unpack_from('<I',data,28); e_phentsize,e_phnum=struct.unpack_from('<HH',data,42)
mu=Uc(UC_ARCH_ARM, UC_MODE_THUMB)
mapped=[]
def mapr(a,sz):
    a0=a&~0xfff; end=(a+sz+0xfff)&~0xfff
    for (s,t) in mapped:
        if a0<t and end>s: a0=max(a0,t) if a0>=s else a0; end=min(end,s) if end<=t and a0<s else end
    if end>a0:
        mu.mem_map(a0,end-a0); mapped.append((a0,end))
for i in range(e_phnum):
    p_type,p_off,p_vaddr,p_paddr,p_filesz,p_memsz,_,_=struct.unpack_from('<8I',data,e_phoff+i*e_phentsize)
    if p_type==1 and p_filesz:
        mapr(p_paddr,p_filesz)
        mu.mem_write(p_paddr,data[p_off:p_off+p_filesz])
FUNC=0x08014574; RAM=0x30000000; STOP=0x40000000
mu.mem_map(RAM,0x10000); mu.mem_map(STOP,0x1000)
mu.mem_write(STOP, b'\x00\xbf'*16)
# enable VFP
mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xf<<20))
mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
OFF=dict(mode=138,m=139,rpr=140,i=141,d=142,pi=143,dg=144,ff=145,pp=148)
def run(mode,m,rpr,i,d,pi,dg,ff,pp):
    prof=RAM+0x100
    mu.mem_write(prof,b'\xaa'*256)
    for k,v in dict(mode=mode,m=m,rpr=rpr,i=i,d=d,pi=pi,dg=dg,ff=ff,pp=pp).items(): mu.mem_write(prof+OFF[k],bytes([v]))
    mu.reg_write(UC_ARM_REG_R0,prof); mu.reg_write(UC_ARM_REG_SP,RAM+0xff00); mu.reg_write(UC_ARM_REG_LR,STOP|1)
    mu.emu_start(FUNC|1, STOP, count=5000)
    out=[]
    for ax in range(3):
        b=mu.mem_read(prof+8+8*ax,8)
        out.append(dict(P=b[0],I=b[1],D=b[2],F=struct.unpack_from('<H',b,4)[0],d_max=mu.mem_read(prof+106+ax,1)[0]))
    return out
if __name__=='__main__':
    print(run(2,100,100,100,100,100,100,100,100))
    print('m50 ff60', run(2,50,100,100,100,100,100,60,100)[0])
    print('m125 pi125 i80', run(2,125,100,80,100,125,100,100,100)[0])
