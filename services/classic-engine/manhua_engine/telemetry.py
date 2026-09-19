"""Windows per-process GPU engine counters (busy time, not shader occupancy)."""
import ctypes as ct
from ctypes import wintypes as wt
import os


class GpuCounters:
    def __init__(self):
        self.query=ct.c_void_p();self.counter=ct.c_void_p();self.available=False
        if os.name!='nt': return
        self.pdh=ct.WinDLL('pdh')
        self.pdh.PdhOpenQueryW.argtypes=[wt.LPCWSTR,ct.c_size_t,ct.POINTER(ct.c_void_p)]
        self.pdh.PdhAddEnglishCounterW.argtypes=[ct.c_void_p,wt.LPCWSTR,ct.c_size_t,ct.POINTER(ct.c_void_p)]
        self.pdh.PdhCollectQueryData.argtypes=[ct.c_void_p]
        self.pdh.PdhCloseQuery.argtypes=[ct.c_void_p]
        self.pdh.PdhGetFormattedCounterArrayW.argtypes=[ct.c_void_p,wt.DWORD,ct.POINTER(wt.DWORD),ct.POINTER(wt.DWORD),ct.c_void_p]
        if self.pdh.PdhOpenQueryW(None,0,ct.byref(self.query)): return
        if self.pdh.PdhAddEnglishCounterW(self.query,r'\GPU Engine(*)\Utilization Percentage',0,ct.byref(self.counter)):
            self.close();return
        self.available=self.pdh.PdhCollectQueryData(self.query)==0

    def read(self):
        if not self.available or self.pdh.PdhCollectQueryData(self.query): return None
        class Value(ct.Structure):
            _fields_=[('status',wt.DWORD),('value',ct.c_double)]
        class Item(ct.Structure):
            _fields_=[('name',wt.LPWSTR),('value',Value)]
        size=wt.DWORD();count=wt.DWORD()
        self.pdh.PdhGetFormattedCounterArrayW(self.counter,0x200,ct.byref(size),ct.byref(count),None)
        if not size.value: return None
        buf=ct.create_string_buffer(size.value)
        rc=self.pdh.PdhGetFormattedCounterArrayW(self.counter,0x200,ct.byref(size),ct.byref(count),buf)
        if rc: return None
        items=ct.cast(buf,ct.POINTER(Item))
        values=[items[i].value.value for i in range(count.value)
                if items[i].name.startswith(f'pid_{os.getpid()}_') and items[i].value.status in (0,1)]
        return max(values,default=0.)

    def close(self):
        if self.query:
            self.pdh.PdhCloseQuery(self.query);self.query=ct.c_void_p()
