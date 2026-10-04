<script>
  let {data}=$props()
  let count=$state(0)
</script>
<h1>SvelteKit {data.answer}</h1>
<button id="count" onclick={()=>count++}>Count: {count}</button>
