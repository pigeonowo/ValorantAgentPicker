class JsHeap {
    constructor(onyx) {
        this.heap = [NaN, 0, null, true, false, globalThis, onyx]
        this.mappedValues = new Map([[0,1],[null,2],[true,3],[false,4],[globalThis,5],[onyx,6]])
        this.freelist = new Array()
    }
    get(x) {
        if ((x | 0) >= this.heap.length) {
            console.error("[JsHeap] Accessing outside of heap bounds.") 
            return null
        }
        return this.heap[x | 0]
    }
    get_or_insert(v) {
        let index = this.mappedValues.get(v)
        if (index === undefined) index = this.insert(v)
        return index
    }
    insert(v) {
        if (this.freelist.length > 0) {
            let i = this.freelist.pop()
            this.heap[i] = v
            return i
        } else {
            this.heap.push(v)
            return this.heap.length - 1
        }
    }
    free(x) {
        if ((x | 0) <= 6) return
        if ((x | 0) >= this.heap.length) {
            console.error("[JsHeap] Deleting outside of heap bounds.") 
            return
        }
        if (this.heap[x | 0] !== undefined) {
            this.heap[x | 0] = undefined
            this.freelist.push(x | 0)
        }
    }
}

export default class Onyx {
    static modules = {}

    static register_module(name, member_getter) {
        Onyx.modules[name] = Onyx.modules[name] || []
        Onyx.modules[name].push(member_getter)
    }

    static async load(source) {
        let res = await fetch(source)
        let wasm_code = await res.arrayBuffer()
        return Onyx.create(wasm_code)
    }

    static async create(wasm_code) {
        let instance = new Onyx()
        let import_object = {}
        for (let name in Onyx.modules) {
            let module_object = {}
            for (let generator of Onyx.modules[name]) {
                module_object = { ...module_object, ...generator(instance) }
            }
            import_object[name] = module_object
        }

        let wasm_module = await WebAssembly.instantiate(wasm_code, import_object)
        instance.memory = wasm_module.instance.exports.memory
        instance.data = new DataView(instance.memory.buffer)
        instance.instance = wasm_module.instance

        return instance
    }

    constructor() {
        this.memory = null
        this.data = null
        this.instance = null
        this.started = false
        this._scratchBuf = new ArrayBuffer(16)
        this._scratchBufView = new DataView(this._scratchBuf)
        this._textDecoder = new TextDecoder("utf-8")
        this._textEncoder = new TextEncoder("utf-8")
        this._heap = new JsHeap(this)
    }

    start() {
        if (this.instance.started) return
        this.instance.started = true

        this.instance.exports._start()
    }

    invoke(name, ...rest) {
        this.start()

        let func = this.instance.exports[name]
        if (func == null) throw new Error(`no such export '${name}'`)

        let args   = rest.map(arg => this.store_value(arg))
        let result = func.call(null, args)
        if (result !== undefined) {
            const index = this.load_value_index(result)
            result = this.load_value(result)
            this._heap.free(index)
        }

        for (let arg of args) {
            const index = this.load_value_index(arg)
            this._heap.free(index)
        }

        return result
    }

    extract_string(ptr, len) {
        const array = new Uint8Array(this.memory.buffer, ptr, len)
        const string = this._textDecoder.decode(array)
        return string
    }

    load_value(value) {
        this._scratchBufView.setBigUint64(0, value, true)
        const fp_value = this._scratchBufView.getFloat64(0, true)

        if (fp_value === 0)   return undefined
        if (!isNaN(fp_value)) return fp_value

        const index = Number(value & 0xffffffffn)
        return this._heap.get(index)
    }

    load_value_index(value) {
        this._scratchBufView.setBigUint64(0, value, true)
        const fp_value = this._scratchBufView.getFloat64(0, true)

        if (fp_value === 0)   return 0
        if (!isNaN(fp_value)) return 0

        const index = Number(value & 0xffffffffn)
        return index
    }

    load_slice_of_values(addr, len) {
        const results = []
        for (let i = 0; i < len; i++) {
            results.push(
                this.load_value(this.data.getBigUint64(addr + i * 8, true))
            )
        }
        return results
    }

    store_value(value) {
        const nan_header_bytes = 0x7ff80000
        if (typeof value === "number" && value !== 0) {
            if (isNaN(value)) {
                this._scratchBufView.setUint32(4, nan_header_bytes, true)
                this._scratchBufView.setUint32(0, 0, true)
                return this._scratchBufView.getBigUint64(0, true)
            }

            this._scratchBufView.setFloat64(0, value, true)
            return this._scratchBufView.getBigUint64(0, true)
        }

        if (value === undefined) return 0n

        const index = this._heap.get_or_insert(value)
        let type_flag = 0
        switch (typeof value) {
            case "object":   if (value !== null) type_flag = 1; break
            case "string":   type_flag = 2; break
            case "symbol":   type_flag = 3; break
            case "function": type_flag = 4; break
        }

        this._scratchBufView.setUint32(4, nan_header_bytes | type_flag, true)
        this._scratchBufView.setUint32(0, index, true)
        return this._scratchBufView.getBigUint64(0, true)
    }
}

Onyx.register_module("host", instance => ({
    print_str(ptr, len) { console.log(instance.extract_string(ptr, len)) },
    time() { return BigInt(Date.now()) },
    exit() { debugger }
}))

Onyx.register_module("__syscall", instance => ({
    __new_object() {
        return instance.store_value({})
    },
    __new_array() {
        return instance.store_value([])
    },
    __new(v, args_ptr, args_len) {
        const args = instance.load_slice_of_values(args_ptr, args_len)
        const obj  = instance.load_value(v)
        const new_obj = instance.store_value(Reflect.construct(obj, args))
        return new_obj
    },
    __delete(v, prop_ptr, prop_len) {
        const value = instance.load_value(v)
        const prop = instance.extract_string(prop_ptr, prop_len)

        Reflect.deleteProperty(value, prop)
    },
    __free(v) {
        const index = instance.load_value_index(v)
        instance._heap.free(index)
    },
    __dot(v, name_ptr, name_len) {
        const name = instance.extract_string(name_ptr, name_len)
        const value = instance.load_value(v)
        const result = instance.store_value(Reflect.get(value, name))
        return result
    },
    __sub(v, i) {
        const value = instance.load_value(v)
        const result = instance.store_value(Reflect.get(value, i))
        return result
    },
    __set(v, name_ptr, name_len, newval) {
        const value = instance.load_value(v)
        const new_value = instance.load_value(newval)
        const name = instance.extract_string(name_ptr, name_len)
        Reflect.set(value, name, new_value)
    },
    __set_index(v, index, newval) {
        const value = instance.load_value(v)
        const new_value = instance.load_value(newval)
        Reflect.set(value, index, new_value)
    },
    __len(v) {
        const value = instance.load_value(v)
        return value.length
    },
    __from_str(ptr, len) {
        const s = instance.extract_string(ptr, len)
        return instance.store_value(s)
    },
    __from_arr(ptr, len) {
        const arr = instance.load_slice_of_values(ptr, len)
        return instance.store_value(arr)
    },
    __call(f, args_ptr, args_len) {
        const args = instance.load_slice_of_values(args_ptr, args_len)
        const func = instance.load_value(f)
        const result = instance.store_value(Reflect.apply(func, undefined, args))
        return result
    },
    __method(v, method_ptr, method_len, args_ptr, args_len) {
        const args = instance.load_slice_of_values(args_ptr, args_len)
        const method = instance.extract_string(method_ptr, method_len)
        const value = instance.load_value(v)
        const func = Reflect.get(value, method)

        const result = instance.store_value(Reflect.apply(func, value, args))
        return result
    },
    __instance_of(v, c) {
        const value = instance.load_value(v)
        const base  = instance.load_value(c)

        if (typeof base !== "object" && typeof base !== "function") return false

        return value instanceof base
    },
    __make_func(funcidx, closureptr) {
        let wasmFunc = instance.instance.exports.__indirect_function_table.get(funcidx)

        return instance.store_value(function() {
            let argptr = instance.instance.exports.__allocate_arg_buf(arguments.length)
            for (let i = 0; i < arguments.length; i++) {
                instance.data.setBigUint64(argptr + i * 8, instance.store_value(arguments[i]), true)
            }

            let thisArg = instance.store_value(this)

            instance.instance.exports.__closure_base.value = closureptr
            wasmFunc(thisArg, argptr, arguments.length)

            const thisIndex = instance.load_value_index(thisArg)
            instance._heap.free(thisIndex)

            instance.instance.exports.__free_arg_buf(argptr)
        })
    },
    __to_str(v, outptr, outlen) {
        const s = instance.load_value(v)
        if (typeof s !== "string") return -1

        const encoded = instance._textEncoder.encode(s)
        if (outlen == 0) return encoded.length

        const onyxmem = new Uint8Array(instance.memory.buffer)
        onyxmem.set(encoded, outptr)
        return encoded.length
    },
    __copy_to_js(a_ref, bufptr, buflen) {
        const a = instance.load_value(a_ref)
        if (!(a instanceof Uint8Array || a instanceof Uint8ClampedArray)) {
            return -1
        }

        const onyxmem = new Uint8Array(instance.memory.buffer)
        const copylen = Math.min(buflen, a.length)
        const to_copy = onyxmem.subarray(bufptr, bufptr+copylen)
        a.set(to_copy)

        return copylen
    },
    __copy_to_onyx(bufptr, buflen, a_ref) {
        const a = instance.load_value(a_ref)
        if (!(a instanceof Uint8Array || a instanceof Uint8ClampedArray)) {
            return -1
        }

        const onyxmem = new Uint8Array(instance.memory.buffer, bufptr)
        const copylen = Math.min(buflen, a.length)
        const to_copy = a.subarray(0, copylen)
        onyxmem.set(to_copy)

        return copylen
    }
}))

