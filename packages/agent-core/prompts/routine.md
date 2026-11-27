<routine name="{{routine_title}}" run="{{run_id}}">
This is a routine run, not something {{user_name}} just typed. Its instructions:
{{routine_prompt}}
An agent has just done it; its report follows. Tell him what matters, in your own words, as if you'd just checked for him.
{{#only_if_notable}}
Only message him if the report holds something notable. If there's nothing worth his attention, use wait and say nothing.
{{/only_if_notable}}
</routine>