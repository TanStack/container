import {readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

// Initial, explicitly enumerated SIMD subset. Apply after stageVectorFoundation.
// Encodings: https://webassembly.github.io/spec/core/binary/instructions.html
export function stageSIMDOps(directory) {
  const widening=[]
  for(const [base,width] of [[0x87,1],[0xa7,2],[0xc7,4]])for(let i=0;i<4;i++)widening.push({op:base+i,mode:0,width,flags:i,binary:false})
  for(const [base,width] of [[0x9c,1],[0xbc,2],[0xdc,4]])for(let i=0;i<4;i++)widening.push({op:base+i,mode:1,width,flags:i,binary:true})
  for(const [base,width] of [[0x65,1],[0x85,2]])for(let i=0;i<2;i++)widening.push({op:base+i,mode:2,width,flags:i,binary:true})
  for(let i=0;i<4;i++)widening.push({op:0x7c+i,mode:3,width:i<2?1:2,flags:i&1,binary:false})
  widening.push({op:0xba,mode:4,width:2,flags:0,binary:true},{op:0x82,mode:5,width:2,flags:0,binary:true})
  const wideningMatch=widening.map(x=>`sub == 0x${x.op.toString(16)}`).join(' || ')
  const reductionOps = [0x60, 0x80, 0xa0, 0xc0].flatMap(base => [base + 3, base + 4])
  const shiftOps = [0x60, 0x80, 0xa0, 0xc0].flatMap(base => [base + 0xb, base + 0xc, base + 0xd])
  const cases = ops => ops.map(op => `case 0x${op.toString(16)}:`).join(' ')
  const shiftReductionMatch = [...reductionOps, ...shiftOps].map(op => `sub == 0x${op.toString(16)}`).join(' || ')
  const arithmeticUnary = [0x60, 0x61, 0x62, 0x80, 0x81, 0xa0, 0xa1, 0xc0, 0xc1]
  const arithmeticBinary = [
    0x6e, 0x6f, 0x70, 0x71, 0x72, 0x73, 0x76, 0x77, 0x78, 0x79, 0x7b,
    0x8e, 0x8f, 0x90, 0x91, 0x92, 0x93, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9b,
    0xb1, 0xb6, 0xb7, 0xb8, 0xb9, 0xce, 0xd1, 0xd5,
  ]
  // Existing i32x4.add/mul keep their original implementation.
  const arithmeticMatch = [...arithmeticUnary, ...arithmeticBinary].map(op => `sub == 0x${op.toString(16)}`).join(' || ')
  // The first range contains 30 integer and 12 floating-point comparisons.
  // The separate six-op range is i64x2, which has signed ordering only.
  const compareCases = [
    ...Array.from({length: 0x4c - 0x23 + 1}, (_, i) => 0x23 + i),
    ...Array.from({length: 6}, (_, i) => 0xd6 + i),
  ].map(op => `case 0x${op.toString(16)}:`).join(' ')
  const files = new Map()
  const replace = (name, from, to) => {
    const source = files.get(name) ?? readFileSync(join(directory, name), 'utf8')
    if (source.split(from).length !== 2) throw Error(`Unexpected SIMD site ${name}: ${from}`)
    files.set(name, source.replace(from, to))
  }

  replace('m3_exec.h', 'd_m3Op(CopySlot_128)', `// Vector bytes are always little endian, independent of host endianness.
static inline u32 SIMDRead32(const u8 *p)
{
    return (u32)p[0] | ((u32)p[1] << 8) | ((u32)p[2] << 16) | ((u32)p[3] << 24);
}
static inline void SIMDWrite32(u8 *p, u32 x)
{
    p[0] = (u8)x; p[1] = (u8)(x >> 8); p[2] = (u8)(x >> 16); p[3] = (u8)(x >> 24);
}

d_m3Op(SIMDConst)
{
    M3V128 value;
    for (u32 i = 0; i < 4; ++i) {
        u32 word = immediate(u32);
        SIMDWrite32(value.bytes + 4 * i, word);
    }
    void *dst = slot_ptr(u8);
    memcpy(dst, &value, sizeof(value));
    nextOp();
}

d_m3Op(SIMDMemory)
{
    u32 sub = immediate(u32), lane = immediate(u32);
    bool laneOp = sub >= 0x54 && sub <= 0x5b;
    bool store = sub == 0x0b || (sub >= 0x58 && sub <= 0x5b);
    u32 width = sub <= 6 && sub != 0 ? 8 : sub >= 7 && sub <= 10 ? 1u << (sub - 7) : laneOp ? 1u << ((sub - 0x54) & 3) : sub == 0x5c ? 4 : sub == 0x5d ? 8 : 16;
    IM3Memory memory = immediate(IM3Memory);
    u32 low = immediate(u32);
    u32 high = immediate(u32);
    u64 offset = (u64)low | ((u64)high << 32);
    u32 wide = immediate(u32);
    u64 address = d_m3WideOperand(wide);
    void *vector = slot_ptr(u8);
    void *destination = laneOp && !store ? slot_ptr(u8) : vector;
    M3MemoryHeader *header = memory->mallocated;
    if (offset > UINT64_MAX - address) {
        newTrap(m3Err_trapOutOfBoundsMemoryAccess);
    }
    address += offset;
    if (!header || !d_m3MemRangeOk(address, width, header)) {
        newTrap(m3Err_trapOutOfBoundsMemoryAccess);
    }
    u8 *bytes = m3MemData(header) + (size_t)address;
    if (store) memcpy(bytes, (u8 *)vector + (laneOp ? lane * width : 0), width);
    else {
        M3V128 result = {{0}};
        if (laneOp) { memcpy(result.bytes, vector, 16); memcpy(result.bytes + lane * width, bytes, width); }
        else if (sub >= 1 && sub <= 6) {
            u32 sourceWidth = 1u << ((sub - 1) / 2), targetWidth = sourceWidth * 2;
            for (u32 at = 0; at < 8; at += sourceWidth) {
                memcpy(result.bytes + at * 2, bytes + at, sourceWidth);
                memset(result.bytes + at * 2 + sourceWidth, (sub & 1) && (bytes[at + sourceWidth - 1] & 0x80) ? 0xff : 0, targetWidth - sourceWidth);
            }
        } else if (sub >= 7 && sub <= 10) {
            for (u32 at = 0; at < 16; at += width) memcpy(result.bytes + at, bytes, width);
        } else memcpy(result.bytes, bytes, width);
        memcpy(destination, result.bytes, 16);
    }
    nextOp();
}

static inline u64 SIMDReadLane(const u8 *p,u32 width) {
    u64 value=0;for(u32 i=0;i<width;i++)value|=(u64)p[i]<<(8*i);return value;
}
static inline i64 SIMDSignedLane(u64 value,u32 width) {
    u64 sign=(u64)1<<(width*8-1);
    return value&sign ? -(i64)((sign<<1)-value) : (i64)value;
}
d_m3Op(SIMDWidening)
{
    u32 mode=immediate(u32),width=immediate(u32),flags=immediate(u32),binary=immediate(u32);
    const u8 *first=slot_ptr(u8),*second=binary?slot_ptr(u8):NULL;
    void *dst=slot_ptr(u8);M3V128 result;
    u32 outputWidth=mode==2?width:mode==5?2:width*2;
    for(u32 at=0;at<16;at+=outputWidth){
        u64 value=0;
        if(mode==0||mode==1){
            u32 source=(flags&1?8:0)+at/2;
            u64 a=SIMDReadLane(first+source,width),b=mode==1?SIMDReadLane(second+source,width):0;
            bool signedValue=flags<2;
            if(signedValue){i64 x=SIMDSignedLane(a,width),y=mode==1?SIMDSignedLane(b,width):0;value=(u64)(mode==1?x*y:x);}
            else value=mode==1?a*b:a;
        }else if(mode==2){
            u32 sourceWidth=width*2,index=at/width;
            const u8 *source=index<8/width?first:second;
            i64 x=SIMDSignedLane(SIMDReadLane(source+(index%(8/width))*sourceWidth,sourceWidth),sourceWidth);
            i64 maximum=flags?((i64)1<<(width*8))-1:((i64)1<<(width*8-1))-1;
            i64 minimum=flags?0:-((i64)1<<(width*8-1));
            value=(u64)(x<minimum?minimum:x>maximum?maximum:x);
        }else if(mode==3){
            u64 a=SIMDReadLane(first+at,width),b=SIMDReadLane(first+at+width,width);
            value=flags?a+b:(u64)(SIMDSignedLane(a,width)+SIMDSignedLane(b,width));
        }else if(mode==4){
            i64 a=SIMDSignedLane(SIMDReadLane(first+at,2),2),b=SIMDSignedLane(SIMDReadLane(second+at,2),2);
            i64 c=SIMDSignedLane(SIMDReadLane(first+at+2,2),2),d=SIMDSignedLane(SIMDReadLane(second+at+2,2),2);
            value=(u64)(a*b+c*d);
        }else{
            i64 a=SIMDSignedLane(SIMDReadLane(first+at,2),2),b=SIMDSignedLane(SIMDReadLane(second+at,2),2);
            i64 x=a*b+16384;
            x=x>=0?x/32768:-((-x+32767)/32768);
            value=(u64)(x>32767?32767:x);
        }
        for(u32 i=0;i<outputWidth;i++)result.bytes[at+i]=(u8)(value>>(8*i));
    }
    memcpy(dst,result.bytes,16);nextOp();
}

d_m3Op(SIMDIntegerArithmetic)
{
    u32 sub = immediate(u32);
    const u8 *first = slot_ptr(u8);
    u32 operation = sub & 0x1f;
    const u8 *second = operation > 2 ? slot_ptr(u8) : NULL;
    void *dst = slot_ptr(u8);
    u32 width = 1u << ((sub - 0x60) / 0x20);
    u32 bits = width * 8;
    u64 mask = UINT64_MAX >> (64 - bits);
    u64 sign = (u64)1 << (bits - 1);
    M3V128 result;
    for (u32 lane = 0; lane < 16; lane += width) {
        u64 a = 0, b = 0, value = 0;
        for (u32 byte = 0; byte < width; ++byte) {
            a |= (u64)first[lane + byte] << (byte * 8);
            if (second) b |= (u64)second[lane + byte] << (byte * 8);
        }
        switch (operation) {
        case 0: value = a & sign ? (u64)0 - a : a; break;
        case 1: value = (u64)0 - a; break;
        case 2:
            for (u32 bit = 0; bit < 8; ++bit) value += (a >> bit) & 1;
            break;
        case 0x0e: value = a + b; break;
        case 0x11: value = a - b; break;
        case 0x15: value = a * b; break;
        case 0x0f: case 0x12: {
            // Only 8/16-bit saturation is dispatched here, so every signed
            // conversion and intermediate is representable in i32.
            i32 modulus = (i32)((u32)1 << bits);
            i32 x = (i32)a - ((a & sign) ? modulus : 0);
            i32 y = (i32)b - ((b & sign) ? modulus : 0);
            i32 z = operation == 0x0f ? x + y : x - y;
            i32 minimum = -(modulus / 2), maximum = modulus / 2 - 1;
            if (z < minimum) z = minimum;
            if (z > maximum) z = maximum;
            value = (u64)z;
            break;
        }
        case 0x10: value = a > mask - b ? mask : a + b; break;
        case 0x13: value = a < b ? 0 : a - b; break;
        case 0x16: value = (a ^ sign) < (b ^ sign) ? a : b; break;
        case 0x17: value = a < b ? a : b; break;
        case 0x18: value = (a ^ sign) > (b ^ sign) ? a : b; break;
        case 0x19: value = a > b ? a : b; break;
        case 0x1b: value = (a >> 1) + (b >> 1) + ((a | b) & 1); break;
        }
        for (u32 byte = 0; byte < width; ++byte)
            result.bytes[lane + byte] = (u8)(value >> (byte * 8));
    }
    memcpy(dst, &result, 16);
    nextOp();
}

d_m3Op(SIMDShiftReduce)
{
    u32 sub = immediate(u32);
    const u8 *source = slot_ptr(u8);
    u32 operation = sub & 0x1f;
    u32 width = 1u << ((sub - 0x60) / 0x20);
    u32 bits = width * 8;
    u32 amount = operation >= 0x0b ? slot(u32) & (bits - 1) : 0;
    void *dst = slot_ptr(u8);
    M3V128 result;
    u32 scalar = operation == 3 ? 1 : 0;
    u64 mask = UINT64_MAX >> (64 - bits);
    u64 sign = (u64)1 << (bits - 1);
    for (u32 lane = 0; lane < 16 / width; ++lane) {
        u64 value = 0;
        for (u32 byte = 0; byte < width; ++byte)
            value |= (u64)source[lane * width + byte] << (byte * 8);
        if (operation == 3) scalar &= value != 0;
        else if (operation == 4) scalar |= (u32)((value & sign) != 0) << lane;
        else {
            u64 shifted;
            if (operation == 0x0b) shifted = value << amount;
            else {
                shifted = value >> amount;
                if (operation == 0x0c && amount != 0 && (value & sign))
                    shifted |= mask ^ (mask >> amount);
            }
            for (u32 byte = 0; byte < width; ++byte)
                result.bytes[lane * width + byte] = (u8)(shifted >> (byte * 8));
        }
    }
    if (operation == 3 || operation == 4) memcpy(dst, &scalar, 4);
    else memcpy(dst, &result, 16);
    nextOp();
}

d_m3Op(SIMDCompare)
{
    u32 sub = immediate(u32);
    const u8 *first = slot_ptr(u8);
    const u8 *second = slot_ptr(u8);
    void *dst = slot_ptr(u8);
    M3V128 result;
    u32 width, predicate;
    bool floating = sub >= 0x41 && sub <= 0x4c;
    bool signedOrder = false;
    if (floating) {
        width = sub < 0x47 ? 4 : 8;
        predicate = sub - (width == 4 ? 0x41 : 0x47);
    } else if (sub >= 0xd6) {
        width = 8;
        predicate = sub - 0xd6;
        signedOrder = predicate >= 2;
    } else {
        u32 group = (sub - 0x23) / 10;
        u32 operation = (sub - 0x23) % 10;
        width = 1u << group;
        predicate = operation < 2 ? operation : 2 + (operation - 2) / 2;
        signedOrder = operation >= 2 && (operation & 1u) == 0;
    }
    for (u32 lane = 0; lane < 16; lane += width) {
        u64 a = 0, b = 0;
        for (u32 byte = 0; byte < width; ++byte) {
            a |= (u64)first[lane + byte] << (8 * byte);
            b |= (u64)second[lane + byte] << (8 * byte);
        }
        bool matched = false;
        if (floating) {
            // Converting f32 to double is exact. Comparisons preserve NaN
            // unordered behavior and treat the two signed zeroes as equal.
            double x, y;
            if (width == 4) {
                u32 ax = (u32)a, by = (u32)b;
                float fx, fy;
                memcpy(&fx, &ax, 4); memcpy(&fy, &by, 4);
                x = fx; y = fy;
            } else {
                memcpy(&x, &a, 8); memcpy(&y, &b, 8);
            }
            switch (predicate) {
            case 0: matched = x == y; break;
            case 1: matched = x != y; break;
            case 2: matched = x < y; break;
            case 3: matched = x > y; break;
            case 4: matched = x <= y; break;
            case 5: matched = x >= y; break;
            }
        } else {
            // Flipping the sign bit maps signed order to unsigned order,
            // without out-of-range unsigned-to-signed conversions.
            if (signedOrder) {
                u64 sign = (u64)1 << (width * 8 - 1);
                a ^= sign; b ^= sign;
            }
            switch (predicate) {
            case 0: matched = a == b; break;
            case 1: matched = a != b; break;
            case 2: matched = a < b; break;
            case 3: matched = a > b; break;
            case 4: matched = a <= b; break;
            case 5: matched = a >= b; break;
            }
        }
        memset(result.bytes + lane, matched ? 0xff : 0, width);
    }
    memcpy(dst, &result, 16);
    nextOp();
}

d_m3Op(SIMDBytes)
{
    u32 sub = immediate(u32);
    u32 lane = immediate(u32);
    M3V128 shuffle;
    if (sub == 0x0d) {
        for (u32 i = 0; i < 4; ++i) {
            u32 word = immediate(u32);
            SIMDWrite32(shuffle.bytes + 4 * i, word);
        }
    }
    const u8 *first = slot_ptr(u8);
    bool binary = sub == 0x0d || sub == 0x0e || sub == 0x17 ||
                  (sub >= 0x4e && sub <= 0x52);
    const u8 *second = binary ? slot_ptr(u8) : NULL;
    const u8 *mask = sub == 0x52 ? slot_ptr(u8) : NULL;
    void *dst = slot_ptr(u8);
    M3V128 value;
    if (sub == 0x15 || sub == 0x16) {
        i32 scalar = first[lane];
        if (sub == 0x15 && scalar >= 128) scalar -= 256;
        memcpy(dst, &scalar, 4);
    } else if (sub == 0x53) {
        u32 scalar = 0;
        for (u32 i = 0; i < 16; ++i) scalar |= first[i];
        scalar = scalar != 0;
        memcpy(dst, &scalar, 4);
    } else {
        if (sub == 0x0f) {
            u32 scalar;
            memcpy(&scalar, first, 4);
            memset(value.bytes, (u8)scalar, 16);
        } else if (sub == 0x17) {
            u32 scalar;
            memcpy(&scalar, second, 4);
            memcpy(value.bytes, first, 16);
            value.bytes[lane] = (u8)scalar;
        } else {
            for (u32 i = 0; i < 16; ++i) {
                switch (sub) {
                case 0x0d: {
                    u32 index = shuffle.bytes[i];
                    value.bytes[i] = index < 16 ? first[index] : second[index - 16];
                    break;
                }
                case 0x0e: value.bytes[i] = second[i] < 16 ? first[second[i]] : 0; break;
                case 0x4d: value.bytes[i] = (u8)~first[i]; break;
                case 0x4e: value.bytes[i] = first[i] & second[i]; break;
                case 0x4f: value.bytes[i] = first[i] & (u8)~second[i]; break;
                case 0x50: value.bytes[i] = first[i] | second[i]; break;
                case 0x51: value.bytes[i] = first[i] ^ second[i]; break;
                case 0x52: value.bytes[i] = (first[i] & mask[i]) | (second[i] & (u8)~mask[i]); break;
                }
            }
        }
        memcpy(dst, &value, 16);
    }
    nextOp();
}

d_m3Op(SIMDExtraLane)
{
    u32 width = immediate(u32), mode = immediate(u32), lane = immediate(u32);
    const u8 *first = slot_ptr(u8);
    const u8 *scalar = mode == 3 ? slot_ptr(u8) : first;
    void *dst = slot_ptr(u8);
    M3V128 result;
    u64 bits = 0;
    if (mode == 1 || mode == 2) {
        for (u32 i = 0; i < width; ++i) bits |= (u64)first[lane * width + i] << (8 * i);
        if (width == 2) {
            u32 word = (u32)bits;
            if (mode == 2 && (word & 0x8000)) word |= 0xffff0000u;
            memcpy(dst, &word, 4);
        } else if (width == 4) { u32 word = (u32)bits; memcpy(dst, &word, 4); }
        else memcpy(dst, &bits, 8);
    } else {
        if (width <= 4) { u32 word; memcpy(&word, scalar, 4); bits = word; }
        else memcpy(&bits, scalar, 8);
        if (mode == 3) memcpy(result.bytes, first, 16);
        for (u32 at = mode == 3 ? lane * width : 0; at < (mode == 3 ? (lane + 1) * width : 16); at += width)
            for (u32 i = 0; i < width; ++i) result.bytes[at + i] = (u8)(bits >> (8 * i));
        memcpy(dst, result.bytes, 16);
    }
    nextOp();
}

d_m3Op(SIMDScalar)
{
    u32 sub = immediate(u32);
    u32 lane = immediate(u32);
    const u8 *first = slot_ptr(u8);
    const u8 *second = (sub == 0xae || sub == 0xb5 || sub == 0xe4) ? slot_ptr(u8) : NULL;
    void *dst = slot_ptr(u8);
    M3V128 value;
    if (sub == 0x1b || sub == 0x1f) {
        u32 word = SIMDRead32(first + 4 * lane);
        memcpy(dst, &word, 4);
    } else if (sub == 0x11 || sub == 0x13) {
        u32 word;
        memcpy(&word, first, 4);
        for (u32 i = 0; i < 4; ++i) SIMDWrite32(value.bytes + 4 * i, word);
        memcpy(dst, &value, 16);
    } else {
        for (u32 i = 0; i < 4; ++i) {
            u32 a = SIMDRead32(first + 4 * i), b = SIMDRead32(second + 4 * i), result;
            if (sub == 0xae) result = a + b;
            else if (sub == 0xb5) result = (u32)((u64)a * b);
            else {
                float x, y, z;
                memcpy(&x, &a, 4); memcpy(&y, &b, 4);
                z = x + y;
                memcpy(&result, &z, 4);
            }
            SIMDWrite32(value.bytes + 4 * i, result);
        }
        memcpy(dst, &value, 16);
    }
    nextOp();
}

d_m3Op(CopySlot_128)`)

  replace('m3_validate.c', '        // ---- Memory load ----', `        case 0xfd:
        {
            u32 sub;
            r = ReadLEB_u32(&sub, &v->wasm, v->wasmEnd); if (r) return r;
            switch (sub) {
            case 0x0c:
                if ((size_t)(v->wasmEnd - v->wasm) < 16) return m3Err_wasmUnderrun;
                v->wasm += 16;
                r = v_push(v, c_m3Type_v128);
                break;
            ${cases([...Array.from({length:12},(_,i)=>i),...Array.from({length:10},(_,i)=>0x54+i)])}
            {
                u32 align, memidx; u64 offset;
                r = ReadMemoryArg(&align, &memidx, &offset, &v->wasm, v->wasmEnd); if (r) return r;
                bool laneOp = sub >= 0x54 && sub <= 0x5b;
                bool store = sub == 0x0b || (sub >= 0x58 && sub <= 0x5b);
                u32 alignment = sub >= 1 && sub <= 6 ? 3 : sub >= 7 && sub <= 10 ? sub - 7 : laneOp ? (sub - 0x54) & 3 : sub == 0x5c ? 2 : sub == 0x5d ? 3 : 4;
                if (align > alignment) return m3Err_invalidAlignment;
                if (!v_has_memory_idx(v, memidx)) return m3Err_unknownMemory;
                if (!v_offset_in_range(v, memidx, offset)) return m3Err_wasmMalformed;
                if (laneOp) {
                    if (v->wasm == v->wasmEnd) return m3Err_wasmUnderrun;
                    if (*v->wasm++ >= (16u >> alignment)) return m3Err_wasmMalformed;
                }
                if (store || laneOp) {
                    r = v_pop_expect(v, c_m3Type_v128, &a); if (r) return r;
                }
                r = v_pop_expect(v, v_memory_addrtype(v, memidx), &a); if (r) return r;
                if (!store) r = v_push(v, c_m3Type_v128);
                break;
            }
            ${cases(widening.filter(x=>!x.binary).map(x=>x.op))}
                r = v_unop(v,c_m3Type_v128,c_m3Type_v128); break;
            ${cases(widening.filter(x=>x.binary).map(x=>x.op))}
                r = v_binop(v,c_m3Type_v128); break;
            ${cases(arithmeticUnary)}
                r = v_unop(v, c_m3Type_v128, c_m3Type_v128); break;
            ${cases(arithmeticBinary)}
                r = v_binop(v, c_m3Type_v128); break;
            ${cases(reductionOps)}
                r = v_unop(v, c_m3Type_v128, c_m3Type_i32); break;
            ${cases(shiftOps)}
                r = v_pop_expect(v, c_m3Type_i32, &a); if (r) return r;
                r = v_unop(v, c_m3Type_v128, c_m3Type_v128); break;
            ${compareCases}
                r = v_binop(v, c_m3Type_v128); break;
            case 0x0d:
                if ((size_t)(v->wasmEnd - v->wasm) < 16) return m3Err_wasmUnderrun;
                for (u32 i = 0; i < 16; ++i) {
                    if (*v->wasm++ >= 32) return m3Err_wasmMalformed;
                }
                r = v_binop(v, c_m3Type_v128);
                break;
            case 0x0e: case 0x4e: case 0x4f: case 0x50: case 0x51:
                r = v_binop(v, c_m3Type_v128); break;
            case 0x4d: r = v_unop(v, c_m3Type_v128, c_m3Type_v128); break;
            case 0x53: r = v_unop(v, c_m3Type_v128, c_m3Type_i32); break;
            case 0x52:
                r = v_pop_expect(v, c_m3Type_v128, &a); if (r) return r;
                r = v_binop(v, c_m3Type_v128); break;
            case 0x15: case 0x16: case 0x17:
                if (v->wasm == v->wasmEnd) return m3Err_wasmUnderrun;
                if (*v->wasm++ >= 16) return m3Err_wasmMalformed;
                if (sub == 0x17) {
                    r = v_pop_expect(v, c_m3Type_i32, &a); if (r) return r;
                    r = v_unop(v, c_m3Type_v128, c_m3Type_v128);
                } else r = v_unop(v, c_m3Type_v128, c_m3Type_i32);
                break;
            case 0x10: r = v_unop(v, c_m3Type_i32, c_m3Type_v128); break;
            case 0x12: r = v_unop(v, c_m3Type_i64, c_m3Type_v128); break;
            case 0x14: r = v_unop(v, c_m3Type_f64, c_m3Type_v128); break;
            case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e: case 0x20: case 0x21: case 0x22: {
                if (v->wasm == v->wasmEnd) return m3Err_wasmUnderrun;
                u32 lanes = sub <= 0x1a ? 8 : (sub == 0x1c || sub == 0x20 ? 4 : 2);
                if (*v->wasm++ >= lanes) return m3Err_wasmMalformed;
                m3type_t scalar = sub <= 0x1c ? c_m3Type_i32 : sub <= 0x1e ? c_m3Type_i64 : sub == 0x20 ? c_m3Type_f32 : c_m3Type_f64;
                bool replaceLane = sub == 0x1a || sub == 0x1c || sub == 0x1e || sub == 0x20 || sub == 0x22;
                if (replaceLane) { r = v_pop_expect(v, scalar, &a); if (r) return r; }
                r = v_unop(v, c_m3Type_v128, replaceLane ? c_m3Type_v128 : scalar);
                break;
            }
            case 0x0f: case 0x11: r = v_unop(v, c_m3Type_i32, c_m3Type_v128); break;
            case 0x13: r = v_unop(v, c_m3Type_f32, c_m3Type_v128); break;
            case 0x1b: case 0x1f:
                if (v->wasm == v->wasmEnd) return m3Err_wasmUnderrun;
                if (*v->wasm++ >= 4) return m3Err_wasmMalformed;
                r = v_unop(v, c_m3Type_v128, sub == 0x1b ? c_m3Type_i32 : c_m3Type_f32);
                break;
            case 0xae: case 0xb5: case 0xe4:
                r = v_binop(v, c_m3Type_v128);
                break;
            default: return m3Err_unknownOpcode;
            }
            if (r) return r;
            break;
        }

        // ---- Memory load ----`)

  replace('m3_compile.c', 'M3Result CompileRawFunction (IM3Module io_module, IM3Function io_function, const void* i_function, const void* i_userdata)', `static M3Result Compile_SIMD(IM3Compilation o, m3opcode_t prefix)
{
    M3Result result = m3Err_none;
    u32 sub, lane = 0;
_   (ReadLEB_u32(&sub, &o->wasm, o->wasmEnd));
    // The full u32 subopcode is compared, never truncated to the low byte.
    _throwif(m3Err_restrictedOpcode, !o->function && sub != 0x0c);
    if (sub == 0x0c) {
        _throwif(m3Err_wasmUnderrun, (size_t)(o->wasmEnd - o->wasm) < 16);
_       (EmitOp(o, op_SIMDConst));
        for (u32 i = 0; i < 4; ++i) {
            EmitConstant32(o, SIMDRead32(o->wasm));
            o->wasm += 4;
        }
_       (PushAllocatedSlotAndEmit(o, c_m3Type_v128));
    } else if (sub <= 0x0b || (sub >= 0x54 && sub <= 0x5d)) {
        u32 align, memidx; u64 offset;
_       (ReadMemoryArg(&align, &memidx, &offset, &o->wasm, o->wasmEnd));
        bool laneOp = sub >= 0x54 && sub <= 0x5b;
        bool store = sub == 0x0b || (sub >= 0x58 && sub <= 0x5b);
        u32 alignment = sub >= 1 && sub <= 6 ? 3 : sub >= 7 && sub <= 10 ? sub - 7 : laneOp ? (sub - 0x54) & 3 : sub == 0x5c ? 2 : sub == 0x5d ? 3 : 4;
        _throwif(m3Err_invalidAlignment, align > alignment);
        _throwif(m3Err_unknownMemory, memidx >= o->module->numMemories);
        IM3Memory memory = o->module->memories[memidx];
        _throwif(m3Err_wasmMalformed, !memory->isMemory64 && offset > UINT32_MAX);
        m3type_t addrtype = Memory_AddrType(memory);
        if (laneOp) {
            _throwif(m3Err_wasmUnderrun, o->wasm == o->wasmEnd);
            lane = *o->wasm++;
            _throwif(m3Err_wasmMalformed, lane >= (16u >> alignment));
        }
        if (store || laneOp) {
_           (CheckOperandType(o, 0, c_m3Type_v128));
        }
_       (CheckOperandType(o, store || laneOp ? 1 : 0, addrtype));
_       (PreserveRegisters(o));
        u16 vector = 0;
        if (store || laneOp) {
            vector = GetStackTopSlotNumber(o);
_           (Pop(o));
        }
        u16 address = GetStackTopSlotNumber(o);
_       (Pop(o));
        if (o->page) {
_           (EnsureCodePageNumLines(o, 12));
        }
_       (EmitOp(o, op_SIMDMemory));
        EmitConstant32(o, sub); EmitConstant32(o, lane);
        EmitPointer(o, memory);
        EmitConstant32(o, (u32)offset);
        EmitConstant32(o, (u32)(offset >> 32));
        EmitConstant32(o, memory->isMemory64);
        EmitSlotOffset(o, address);
        if (store || laneOp) EmitSlotOffset(o, vector);
        if (!store) {
_           (PushAllocatedSlotAndEmit(o, c_m3Type_v128));
        }
    } else if (${wideningMatch}) {
        u32 mode=0,width=0,flags=0,binary=0;
        switch(sub){
        ${widening.map(x=>`case 0x${x.op.toString(16)}: mode=${x.mode};width=${x.width};flags=${x.flags};binary=${Number(x.binary)};break;`).join('\n')}
        }
_       (CheckOperandType(o,0,c_m3Type_v128));
        if(binary){_ (CheckOperandType(o,1,c_m3Type_v128));}
_       (PreserveRegisters(o));
        u16 second=GetStackTopSlotNumber(o);
_       (Pop(o));
        u16 first=second;
        if(binary){first=GetStackTopSlotNumber(o);_ (Pop(o));}
_       (EnsureCodePageNumLines(o,9));
_       (EmitOp(o,op_SIMDWidening));
        EmitConstant32(o,mode);EmitConstant32(o,width);EmitConstant32(o,flags);EmitConstant32(o,binary);
        EmitSlotOffset(o,first);if(binary)EmitSlotOffset(o,second);
_       (PushAllocatedSlotAndEmit(o,c_m3Type_v128));
    } else if (${arithmeticMatch}) {
        bool binary = (sub & 0x1f) > 2;
_       (CheckOperandType(o, 0, c_m3Type_v128));
        if (binary) {
_           (CheckOperandType(o, 1, c_m3Type_v128));
        }
_       (PreserveRegisters(o));
        u16 second = GetStackTopSlotNumber(o);
_       (Pop(o));
        u16 first = second;
        if (binary) {
            first = GetStackTopSlotNumber(o);
_           (Pop(o));
        }
_       (EmitOp(o, op_SIMDIntegerArithmetic));
        EmitConstant32(o, sub);
        EmitSlotOffset(o, first);
        if (binary) EmitSlotOffset(o, second);
_       (PushAllocatedSlotAndEmit(o, c_m3Type_v128));
    } else if (${shiftReductionMatch}) {
        bool shift = (sub & 0x1f) >= 0x0b;
        if (shift) {
_           (CheckOperandType(o, 0, c_m3Type_i32));
        }
_       (CheckOperandType(o, shift ? 1 : 0, c_m3Type_v128));
_       (PreserveRegisters(o));
        u16 amount = 0;
        if (shift) {
            amount = GetStackTopSlotNumber(o);
_           (Pop(o));
        }
        u16 source = GetStackTopSlotNumber(o);
_       (Pop(o));
_       (EmitOp(o, op_SIMDShiftReduce));
        EmitConstant32(o, sub);
        EmitSlotOffset(o, source);
        if (shift) EmitSlotOffset(o, amount);
_       (PushAllocatedSlotAndEmit(o, shift ? c_m3Type_v128 : c_m3Type_i32));
    } else if ((sub >= 0x23 && sub <= 0x4c) || (sub >= 0xd6 && sub <= 0xdb)) {
#if !d_m3HasFloat
        _throwif(m3Err_unknownOpcode, sub >= 0x41 && sub <= 0x4c);
#endif
_       (CheckOperandType(o, 0, c_m3Type_v128));
_       (CheckOperandType(o, 1, c_m3Type_v128));
_       (PreserveRegisters(o));
        u16 second = GetStackTopSlotNumber(o);
_       (Pop(o));
        u16 first = GetStackTopSlotNumber(o);
_       (Pop(o));
_       (EmitOp(o, op_SIMDCompare));
        EmitConstant32(o, sub);
        EmitSlotOffset(o, first);
        EmitSlotOffset(o, second);
_       (PushAllocatedSlotAndEmit(o, c_m3Type_v128));
    } else if (sub == 0x0d || sub == 0x0e || sub == 0x0f ||
               sub == 0x15 || sub == 0x16 || sub == 0x17 ||
               (sub >= 0x4d && sub <= 0x53)) {
        m3type_t inputs[3] = {c_m3Type_v128, c_m3Type_v128, c_m3Type_v128};
        m3type_t output = c_m3Type_v128;
        u16 count = 1;
        M3V128 shuffle;
        if (sub == 0x0d) {
            _throwif(m3Err_wasmUnderrun, (size_t)(o->wasmEnd - o->wasm) < 16);
            for (u32 i = 0; i < 16; ++i) {
                shuffle.bytes[i] = *o->wasm++;
                _throwif(m3Err_wasmMalformed, shuffle.bytes[i] >= 32);
            }
        }
        if (sub == 0x15 || sub == 0x16 || sub == 0x17) {
            _throwif(m3Err_wasmUnderrun, o->wasm == o->wasmEnd);
            lane = *o->wasm++;
            _throwif(m3Err_wasmMalformed, lane >= 16);
        }
        if (sub == 0x0d || sub == 0x0e || (sub >= 0x4e && sub <= 0x51)) count = 2;
        if (sub == 0x52) count = 3;
        if (sub == 0x0f) inputs[0] = c_m3Type_i32;
        if (sub == 0x17) { count = 2; inputs[1] = c_m3Type_i32; }
        if (sub == 0x15 || sub == 0x16 || sub == 0x53) output = c_m3Type_i32;
        for (u16 i = 0; i < count; ++i) {
_           (CheckOperandType(o, count - 1 - i, inputs[i]));
        }
_       (PreserveRegisters(o));
        u16 slots[3];
        for (u16 i = count; i > 0; --i) {
            slots[i - 1] = GetStackTopSlotNumber(o);
_           (Pop(o));
        }
        // Shuffle is op + sub + lane + four words + two inputs + output,
        // plus the two-word page bridge, larger than the scalar threshold.
        if (o->page) {
_           (EnsureCodePageNumLines(o, 12));
        }
_       (EmitOp(o, op_SIMDBytes));
        EmitConstant32(o, sub);
        EmitConstant32(o, lane);
        if (sub == 0x0d) {
            for (u32 i = 0; i < 4; ++i) EmitConstant32(o, SIMDRead32(shuffle.bytes + 4 * i));
        }
        for (u16 i = 0; i < count; ++i) EmitSlotOffset(o, slots[i]);
_       (PushAllocatedSlotAndEmit(o, output));
    } else if (sub == 0x10 || sub == 0x12 || sub == 0x14 || (sub >= 0x18 && sub <= 0x1a) || (sub >= 0x1c && sub <= 0x1e) || (sub >= 0x20 && sub <= 0x22)) {
        u32 width = sub == 0x10 || (sub >= 0x18 && sub <= 0x1a) ? 2 : sub == 0x1c || sub == 0x20 ? 4 : 8;
        bool splat = sub == 0x10 || sub == 0x12 || sub == 0x14;
        bool replaceLane = sub == 0x1a || sub == 0x1c || sub == 0x1e || sub == 0x20 || sub == 0x22;
        m3type_t scalar = sub == 0x10 || (sub >= 0x18 && sub <= 0x1c) ? c_m3Type_i32 : sub == 0x12 || sub == 0x1d || sub == 0x1e ? c_m3Type_i64 : sub == 0x20 ? c_m3Type_f32 : c_m3Type_f64;
#if !d_m3HasFloat
        _throwif(m3Err_unknownOpcode, scalar == c_m3Type_f32 || scalar == c_m3Type_f64);
#endif
        if (!splat) {
            _throwif(m3Err_wasmUnderrun, o->wasm == o->wasmEnd);
            lane = *o->wasm++;
            _throwif(m3Err_wasmMalformed, lane >= 16 / width);
        }
_       (CheckOperandType(o, 0, splat || replaceLane ? scalar : c_m3Type_v128));
        if (replaceLane) { _ (CheckOperandType(o, 1, c_m3Type_v128)); }
_       (PreserveRegisters(o));
        u16 second = GetStackTopSlotNumber(o);
_       (Pop(o));
        u16 first = second;
        if (replaceLane) { first = GetStackTopSlotNumber(o); _ (Pop(o)); }
_       (EmitOp(o, op_SIMDExtraLane));
        EmitConstant32(o, width); EmitConstant32(o, splat ? 0 : replaceLane ? 3 : sub == 0x18 ? 2 : 1); EmitConstant32(o, lane);
        EmitSlotOffset(o, first); if (replaceLane) EmitSlotOffset(o, second);
_       (PushAllocatedSlotAndEmit(o, splat || replaceLane ? c_m3Type_v128 : scalar));
    } else {
        m3type_t input = c_m3Type_v128, output = c_m3Type_v128;
        bool binary = false;
        switch (sub) {
        case 0x11: input = c_m3Type_i32; break;
        case 0x13: input = c_m3Type_f32; break;
        case 0x1b: case 0x1f:
            _throwif(m3Err_wasmUnderrun, o->wasm == o->wasmEnd);
            lane = *o->wasm++;
            _throwif(m3Err_wasmMalformed, lane >= 4);
            output = sub == 0x1b ? c_m3Type_i32 : c_m3Type_f32;
            break;
        case 0xae: case 0xb5: case 0xe4: binary = true; break;
        default: _throw(m3Err_unknownOpcode);
        }
#if !d_m3HasFloat
        _throwif(m3Err_unknownOpcode, sub == 0x13 || sub == 0x1f || sub == 0xe4);
#endif
_       (CheckOperandType(o, 0, input));
        if (binary) {
_           (CheckOperandType(o, 1, input));
        }
_       (PreserveRegisters(o));
        u16 second = GetStackTopSlotNumber(o);
_       (Pop(o));
        u16 first = second;
        if (binary) {
            first = GetStackTopSlotNumber(o);
_           (Pop(o));
        }
_       (EmitOp(o, op_SIMDScalar));
        EmitConstant32(o, sub);
        EmitConstant32(o, lane);
        EmitSlotOffset(o, first);
        if (binary) EmitSlotOffset(o, second);
_       (PushAllocatedSlotAndEmit(o, output));
    }
    _catch: return result;
}

M3Result CompileRawFunction (IM3Module io_module, IM3Function io_function, const void* i_function, const void* i_userdata)`)
  replace('m3_compile.c', '    _( Compile_ExtendedOpcode )', ['    _( Compile_SIMD )                  ' + '\\', '    _( Compile_ExtendedOpcode )'].join('\n'))
  replace('m3_compile.c', '    c_opHigh_extended   // always present, so the enum is never empty',
    '    c_opHigh_simd,\n    c_opHigh_extended   // always present, so the enum is never empty')
  replace('m3_compile.c', '    M3OP( "0xFC",', '    M3OP( "0xFD", 0, c_m3Type_unknown, d_cc(Compile_SIMD), d_emptyOpList ),\n    M3OP( "0xFC",')
  replace('m3_compile.c', '    case c_waOp_extended: return c_opHigh_extended;',
    '    case 0xfd: return c_opHigh_simd;\n    case c_waOp_extended: return c_opHigh_extended;')
  replace('m3_compile.c', '            case c_waOp_getGlobal: case c_waOp_end:',
    '            case 0xfd: // Compile_SIMD permits only v128.const in expressions.\n            case c_waOp_getGlobal: case c_waOp_end:')

  for (const [name, source] of files) writeFileSync(join(directory, name), source)
}
